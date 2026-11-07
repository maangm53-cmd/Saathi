import { handle } from "@/lib/server";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) { return handle(request, (await context.params).action); }
export async function POST(request: Request, context: Context) { return handle(request, (await context.params).action); }
