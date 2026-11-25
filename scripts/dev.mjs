#!/usr/bin/env node
/**
 * Starts the API server and Vite together, with clean shutdown.
 * Keeping this in-repo avoids a process-manager dependency.
 */
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Set();
let shuttingDown = false;

function run(name, args, color) {
  const child = spawn(npm, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  children.add(child);

  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(prefix + line + "\n");
    });
  }

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`${prefix}exited (${signal ?? code}). Shutting down...`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", ["run", "dev:server"], "33");
run("web", ["run", "dev:client"], "36");
