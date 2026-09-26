import { corsHeaders, json, requireAdmin } from "../_shared/admin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  try {
    const { service } = await requireAdmin(req);
    const { sector } = await req.json();
    if (typeof sector !== "string" || !sector.trim()) {
      return json({ error: "Setor inválido" }, 400);
    }

    const shared = sector === "QOE" ? ["QOE", "BCC"] : sector === "BCC" ? ["BCC", "QOE"] : [sector];
    const { data: profiles, error: profileError } = await service
      .from("profiles")
      .select("id")
      .in("sector", shared);
    if (profileError) throw profileError;

    const userIds = (profiles ?? []).map((profile) => profile.id);
    if (!userIds.length) return json({ skipped: true, reason: "Nenhum funcionário no setor." });

    const { data: pending, error: pendingError } = await service
      .from("vacation_requests")
      .select("id,user_id,start_date,end_date,created_at")
      .eq("status", "pending")
      .in("user_id", userIds)
      .order("created_at", { ascending: true });
    if (pendingError) throw pendingError;
    if (!pending?.length) return json({ skipped: true, reason: "Nenhuma solicitação pendente." });

    const { data: history, error: historyError } = await service
      .from("vacation_history")
      .select("user_id,start_date,end_date,is_critical_period")
      .in("user_id", userIds);
    if (historyError) throw historyError;

    const historicalDays = new Map<string, number>();
    for (const item of history ?? []) {
      const days = Math.round((Date.parse(`${item.end_date}T12:00:00Z`) - Date.parse(`${item.start_date}T12:00:00Z`)) / 86400000) + 1;
      const weight = days + (item.is_critical_period ? 15 : 0);
      historicalDays.set(item.user_id, (historicalDays.get(item.user_id) ?? 0) + weight);
    }

    pending.sort((a, b) => {
      const score = (historicalDays.get(a.user_id) ?? 0) - (historicalDays.get(b.user_id) ?? 0);
      return score || a.created_at.localeCompare(b.created_at);
    });

    const decisions = [];
    let failures = 0;
    for (const request of pending) {
      const { error } = await service
        .from("vacation_requests")
        .update({ status: "approved", admin_notes: "Aprovada pela curadoria automática", rejection_reason: null })
        .eq("id", request.id);

      if (!error) {
        decisions.push({ id: request.id, action: "approve", success: true });
        continue;
      }

      const reason = error.message.includes("sobreposição")
        ? "Reprovada pela curadoria: conflito de escala superior a 3 dias."
        : `Reprovada pela curadoria: ${error.message}`;
      const { error: rejectError } = await service
        .from("vacation_requests")
        .update({ status: "rejected", rejection_reason: reason, admin_notes: "Curadoria automática" })
        .eq("id", request.id);
      if (rejectError) failures += 1;
      decisions.push({ id: request.id, action: "reject", success: !rejectError });
    }

    return json({ decisions, failures });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erro inesperado" }, 403);
  }
});

