import { DineInResolver } from "./DineInResolver";

// Public dine-in entry (frozen UI1-A + UI1-B1). Reads the opaque QR token
// from ?table=<token> and hands it to the client resolver. The token is never
// rendered or logged here. No session open / login redirect / menu flow yet.
export default async function DineInPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string | string[] }>;
}) {
  const { table } = await searchParams;
  const token = typeof table === "string" && table.length > 0 ? table : null;
  return <DineInResolver token={token} />;
}
