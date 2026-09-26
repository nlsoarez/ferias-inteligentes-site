import { corsHeaders, json, requireAdmin } from "../_shared/admin.ts";

const normalizeLogin = (value: string) => value
  .trim()
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, ".");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  try {
    const { service } = await requireAdmin(req);
    const body = await req.json();
    const registration = String(body.registration ?? "").trim();
    const fullName = String(body.fullName ?? "").trim();
    const sector = String(body.sector ?? "").trim();
    const password = String(body.password ?? "");

    if (!fullName || !sector || password.length < 8) {
      return json({ error: "Nome, setor e senha de ao menos 8 caracteres são obrigatórios." }, 400);
    }

    const login = normalizeLogin(registration || fullName);
    const email = login.endsWith("@ferias.interno") ? login : `${login}@ferias.interno`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("Falha ao criar usuário");

    const userId = data.user.id;
    const { error: profileError } = await service.from("profiles").insert({
      id: userId,
      registration: registration || null,
      full_name: fullName,
      sector,
      must_change_password: true,
    });
    const { error: roleError } = profileError
      ? { error: null }
      : await service.from("user_roles").insert({ user_id: userId, role: "employee" });

    if (profileError || roleError) {
      await service.auth.admin.deleteUser(userId);
      throw profileError ?? roleError;
    }

    return json({ userId, login });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erro inesperado" }, 403);
  }
});

