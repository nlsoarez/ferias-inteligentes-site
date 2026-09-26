import { corsHeaders, json, requireAdmin } from "../_shared/admin.ts";

function temporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `F!${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  try {
    const { service } = await requireAdmin(req);
    const { userId } = await req.json();
    if (typeof userId !== "string") return json({ error: "Usuário inválido" }, 400);

    const password = temporaryPassword();
    const { error } = await service.auth.admin.updateUserById(userId, { password });
    if (error) throw error;

    const { error: profileError } = await service
      .from("profiles")
      .update({ must_change_password: true })
      .eq("id", userId);
    if (profileError) throw profileError;

    return json({ temporaryPassword: password });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erro inesperado" }, 403);
  }
});

