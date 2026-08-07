// O10 Price Breakdown - transparent itemized cost before checkout.
// Uses the Teal palette (primary-500, accent-600) and Indian rupee
// formatting (en-IN). GST labels reflect the Indian food context.
import { formatINR } from "@/lib/pricing";

export interface BreakdownItem {
  label: string;
  amount: number;
  bold?: boolean;
}

export function PriceBreakdown({
  items,
  foodSubtotal,
  gstFood,
  packagingFee,
  gstPackaging,
  total,
}: {
  items: BreakdownItem[];
  foodSubtotal: number;
  gstFood: number;
  packagingFee: number;
  gstPackaging: number;
  total: number;
}) {
  const rows: BreakdownItem[] = [
    {
      label: "Food Subtotal",
      amount: foodSubtotal,
    },
    {
      label: "GST on Food (5%)",
      amount: gstFood,
    },
    {
      label: "Packaging Fee",
      amount: packagingFee,
    },
    {
      label: "GST on Packaging (18%)",
      amount: gstPackaging,
    },
  ];

  return (
    <div className="space-y-2 rounded-xl bg-surface-light p-4">
      {items.map((item, i) => (
        <div
          key={`item-${i}`}
          className="flex justify-between text-sm text-neutral-600"
        >
          <span>
            {item.label}{" "}
            {item.amount === 0 ? "(Free)" : `+${formatINR(item.amount)}`}
          </span>
        </div>
      ))}

      <hr className="border-primary-500/20" />

      {rows.map((row, i) => (
        <div
          key={`row-${i}`}
          className="flex justify-between text-sm text-neutral-600"
        >
          <span>{row.label}</span>
          <span>{formatINR(row.amount)}</span>
        </div>
      ))}

      <hr className="border-primary-500/30" />

      <div className="flex justify-between text-base font-bold text-primary-700">
        <span>Total</span>
        <span>{formatINR(total)}</span>
      </div>
    </div>
  );
}
