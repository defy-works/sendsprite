import { NextResponse } from "next/server";
import { collect } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const h = await collect();
  return NextResponse.json(h, { status: h.status === "error" ? 503 : 200 });
}
