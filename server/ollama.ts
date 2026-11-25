import { spawn } from "node:child_process";
import { config } from "./config";

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export type OllamaStatus = "ready" | "unavailable";

export interface OllamaHealth {
  status: OllamaStatus;
  message: string;
  models: string[];
  liveModel: string;
  finalModel: string;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface ChatOptions {
  numPredict?: number;
  numCtx?: number;
  temperature?: number;
  timeoutMs?: number;
  keepAlive?: string;
}

function contextFor(messages: ChatMessage[], numPredict: number): number {
  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  const needed = Math.ceil(chars / 3.5) + numPredict + 512;
  const tiers = [8_192, 16_384, 32_768];
  return (
    tiers.find((tier) => tier >= needed) ??
    Math.min(config.notes.maxNumCtx, 32_768)
  );
}

function assertLocalUrl(): void {
  const url = new URL(config.ollama.url);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("OLLAMA_URL must point to a loopback address for offline use.");
  }
}

function modelNames(models: OllamaModel[]): string[] {
  return models.map((model) => model.name).sort();
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object"
      ? String((cause as { code?: string }).code ?? "")
      : String(cause ?? "");
  return (
    error.name === "TypeError" ||
    /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(
      `${error.message} ${causeCode}`,
    )
  );
}

function spawnDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The app may already be running or the CLI may not be on PATH.
  }
}

class OllamaService {
  private models: string[] = [];
  private starting: Promise<boolean> | null = null;
  private healthValue: OllamaHealth = {
    status: "unavailable",
    message: "Checking Ollama…",
    models: [],
    liveModel: config.ollama.liveModel,
    finalModel: config.ollama.finalModel,
  };

  get health(): OllamaHealth {
    return this.healthValue;
  }

  get liveModel(): string {
    if (this.models.includes(config.ollama.liveModel)) return config.ollama.liveModel;
    if (this.models.includes(config.ollama.finalModel)) return config.ollama.finalModel;
    return this.models[0] ?? config.ollama.liveModel;
  }

  get finalModel(): string {
    if (this.models.includes(config.ollama.finalModel)) return config.ollama.finalModel;
    return this.liveModel;
  }

  async ping(): Promise<boolean> {
    try {
      assertLocalUrl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_500);
      try {
        const response = await fetch(`${config.ollama.url}/api/tags`, {
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }

  /**
   * Ensure Ollama is running. If it is not, try to launch the desktop app or
   * `ollama serve` automatically and wait for the local API to come up.
   */
  async ensureReady(): Promise<boolean> {
    if (await this.ping()) {
      await this.refresh();
      return this.healthValue.status === "ready";
    }
    if (!this.starting) {
      this.starting = this.startServer().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async startServer(): Promise<boolean> {
    this.healthValue = {
      ...this.healthValue,
      status: "unavailable",
      message: "Starting Ollama automatically…",
    };
    if (process.platform === "darwin") {
      spawnDetached("open", ["-a", "Ollama"]);
    }
    spawnDetached("ollama", ["serve"]);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.ping()) {
        await this.refresh();
        return this.healthValue.status === "ready";
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await this.refresh();
    return false;
  }

  async refresh(): Promise<OllamaHealth> {
    try {
      assertLocalUrl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4_000);
      let response: Response;
      try {
        response = await fetch(`${config.ollama.url}/api/tags`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
      const data = (await response.json()) as { models?: OllamaModel[] };
      this.models = modelNames(data.models ?? []);
      if (this.models.length === 0) {
        this.healthValue = {
          status: "unavailable",
          message:
            "Ollama is running, but no models are installed. Run: ollama pull qwen2.5:3b",
          models: [],
          liveModel: config.ollama.liveModel,
          finalModel: config.ollama.finalModel,
        };
        return this.healthValue;
      }
      const live = this.liveModel;
      const final = this.finalModel;
      const missingFinal = !this.models.includes(config.ollama.finalModel);
      this.healthValue = {
        status: "ready",
        message:
          `Ollama is ready. Live: ${live}. Final: ${final}.` +
          (missingFinal && config.ollama.finalModel !== live
            ? ` (${config.ollama.finalModel} is not installed; using ${live} for final notes.)`
            : ""),
        models: this.models,
        liveModel: live,
        finalModel: final,
      };
    } catch (error) {
      this.models = [];
      const starting = this.starting !== null;
      this.healthValue = {
        status: "unavailable",
        message: starting
          ? "Starting Ollama automatically…"
          : error instanceof Error && error.name === "AbortError"
            ? "Ollama did not respond. It may still be loading."
            : isNetworkError(error)
              ? "Ollama isn't running yet. The app will start it automatically; this can take a few seconds."
              : `Ollama is unavailable. ${
                  error instanceof Error ? error.message : ""
                }`.trim(),
        models: [],
        liveModel: config.ollama.liveModel,
        finalModel: config.ollama.finalModel,
      };
    }
    return this.healthValue;
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<string> {
    assertLocalUrl();
    if (!(await this.ping())) {
      const ready = await this.ensureReady();
      if (!ready) {
        throw new Error(
          "Ollama isn't running. Open the Ollama app or run `ollama serve`, then try again.",
        );
      }
    }
    if (!this.models.includes(model)) {
      await this.refresh();
    }
    if (!this.models.includes(model)) {
      throw new Error(
        `The Ollama model "${model}" is not installed. Run: ollama pull ${model}`,
      );
    }

    try {
      return await this.chatOnce(model, messages, options);
    } catch (error) {
      if (isNetworkError(error)) {
        const ready = await this.ensureReady();
        if (ready) {
          try {
            return await this.chatOnce(model, messages, options);
          } catch (retryError) {
            error = retryError;
          }
        }
      }

      // Ollama can report a transient runner-start timeout while the model is
      // loading under memory pressure. One short retry usually succeeds.
      if (
        error instanceof Error &&
        /timed out waiting for llama-server to start/i.test(error.message)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        try {
          return await this.chatOnce(model, messages, options);
        } catch {
          throw new Error(
            "The local model took too long to load. Close memory-heavy apps and try again.",
          );
        }
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Ollama took too long to generate notes. Try a smaller model.");
      }
      if (isNetworkError(error)) {
        throw new Error(
          "Ollama stopped responding. The app is restarting it; please try again in a moment.",
        );
      }
      throw error instanceof Error ? error : new Error("Note generation failed.");
    }
  }

  private async chatOnce(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<string> {
    const numPredict = options.numPredict ?? config.notes.numPredict;
    const numCtx =
      options.numCtx ??
      Math.max(config.notes.numCtx, contextFor(messages, numPredict));
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 10 * 60_000,
    );
    try {
      const response = await fetch(`${config.ollama.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          keep_alive: options.keepAlive ?? "30m",
          options: {
            temperature: options.temperature ?? 0.15,
            top_p: 0.9,
            repeat_penalty: 1.15,
            repeat_last_n: 128,
            num_ctx: numCtx,
            num_predict: numPredict,
          },
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Ollama returned HTTP ${response.status}. ${body.slice(0, 300)}`.trim(),
        );
      }
      const data = (await response.json()) as {
        message?: { content?: string };
        error?: string;
      };
      if (data.error) throw new Error(data.error);
      const content = data.message?.content?.trim() ?? "";
      if (!content) throw new Error("Ollama returned an empty response.");
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }

  async warmup(): Promise<boolean> {
    try {
      await this.chat(
        this.liveModel,
        [{ role: "user", content: "Reply with exactly: OK" }],
        { numPredict: 2, timeoutMs: 180_000, keepAlive: "30m" },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Release model memory after a lecture is finalized. */
  async unload(model: string): Promise<void> {
    try {
      await fetch(`${config.ollama.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
    } catch {
      // Unloading is best-effort; the next request will reload the model.
    }
  }
}

export const ollama = new OllamaService();
