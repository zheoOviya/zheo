import PDFDocument from "pdfkit";
import type { SettlementSummary } from "./settlement";

// ============================================
// PDF Generator - Daily Settlement Report
// pdfkit streams the report into a Buffer that
// the route sends back with Content-Type
// application/pdf.
// ============================================

function inr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Renders the settlement report to a PDF Buffer.
 * Layout follows the receipt style used across SnakZap.
 */
export async function renderSettlementPdf(
  restaurantName: string,
  summary: SettlementSummary,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ margin: 48, size: "A4" });
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const periodLabel = summary.period_start.slice(0, 10);

  doc.fontSize(16).fillColor("#0D9488").text("SnakZap - Daily Settlement Report");
  doc.moveDown(0.4);
  doc.fontSize(10).fillColor("#111827");
  doc.text(`Restaurant: ${restaurantName}`);
  doc.text(`Settlement Date: ${periodLabel} (UTC)`);
  doc.text(`Orders: ${summary.order_count}`);
  doc.moveDown(0.6);

  const headerY = doc.y;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151");
  const columns = [
    { label: "Order", width: 110 },
    { label: "Value", width: 90 },
    { label: "Commission", width: 90 },
    { label: "Tax", width: 80 },
    { label: "Payout", width: 90 },
  ];
  let x = doc.x;
  for (const col of columns) {
    doc.text(col.label, x, headerY, { width: col.width, align: "left" });
    x += col.width;
  }
  doc.moveDown(0.4);

  doc.font("Helvetica").fontSize(9).fillColor("#111827");
  for (const line of summary.lines) {
    const y = doc.y;
    let cx = doc.x;
    doc.text(line.order_number, cx, y, { width: 110 });
    cx += 110;
    doc.text(inr(line.total_amount), cx, y, { width: 90 });
    cx += 90;
    doc.text(inr(line.commission_amount), cx, y, { width: 90 });
    cx += 90;
    doc.text(inr(line.taxes), cx, y, { width: 80 });
    cx += 80;
    doc.text(inr(line.payout), cx, y, { width: 90 });
    doc.moveDown(0.3);
  }

  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0F766E");
  doc.text(
    `Net Payout: ${inr(summary.net_payout)}  (Commission: ${inr(summary.total_commission)}, Tax: ${inr(summary.total_taxes)})`,
  );

  doc.end();
  return done;
}
