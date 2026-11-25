import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

export async function exportNotesPdf(
  title: string,
  meta: string,
  notesElement: HTMLElement,
): Promise<void> {
  const sheet = document.createElement("div");
  sheet.className = "pdf-sheet";
  const heading = document.createElement("div");
  heading.className = "pdf-sheet-heading";
  const titleElement = document.createElement("h1");
  titleElement.textContent = title;
  const metaElement = document.createElement("p");
  metaElement.textContent = meta;
  heading.append(titleElement, metaElement);

  const clone = notesElement.cloneNode(true) as HTMLElement;
  clone.classList.add("pdf-notes");
  sheet.append(heading, clone);
  document.body.appendChild(sheet);

  try {
    const canvas = await html2canvas(sheet, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: false,
      logging: false,
      windowWidth: 900,
    });
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const margin = 14;
    const pageWidth = 210;
    const pageHeight = 297;
    const usableWidth = pageWidth - margin * 2;
    const usableHeight = pageHeight - margin * 2;
    const imageHeight = (canvas.height * usableWidth) / canvas.width;
    let offset = 0;
    let page = 0;

    while (offset < imageHeight - 0.5) {
      if (page > 0) pdf.addPage();
      pdf.addImage(
        canvas,
        "PNG",
        margin,
        margin - offset,
        usableWidth,
        imageHeight,
        undefined,
        "FAST",
      );
      offset += usableHeight;
      page += 1;
    }

    const safe = title
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 70);
    pdf.save(`${safe || "lecture-notes"}.pdf`);
  } finally {
    sheet.remove();
  }
}
