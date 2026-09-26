const fs = require("node:fs");

const SUPABASE_URL = "https://zhandzhtitymguskgskm.supabase.co";
const SUPABASE_KEY = "sb_publishable_WEzOMEWWmnZC8u97KCz-Hw_ski5_ptI";
const password = process.env.MIGRATION_ADMIN_PASSWORD;

if (!password) throw new Error("MIGRATION_ADMIN_PASSWORD não definida");

function parseCsv(file) {
  const input = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const headers = rows.shift();
  return rows
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

const nullable = (value) => value === "" || value === "null" ? null : value;
const bool = (value) => value === "true";

async function request(path, { method = "GET", token, body, prefer } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${data?.message ?? data?.error ?? text}`);
  }
  return data;
}

async function main() {
  const [profilesFile, requestsFile, historyOneFile, historyTwoFile, holidaysFile] = process.argv.slice(2);
  if (!holidaysFile) throw new Error("Informe os cinco arquivos CSV exportados");

  const profiles = parseCsv(profilesFile);
  const vacationRequests = parseCsv(requestsFile);
  const vacationHistory = [...parseCsv(historyOneFile), ...parseCsv(historyTwoFile)];
  const holidays = parseCsv(holidaysFile);

  const auth = await request("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: "admin@ferias.interno", password },
  });
  const token = auth.access_token;

  const currentProfiles = await request("/rest/v1/profiles?select=id,registration,full_name", { token });
  const byRegistration = new Map(currentProfiles.filter((item) => item.registration).map((item) => [item.registration, item.id]));
  const newAdmin = currentProfiles.find((item) => item.registration === "admin");
  if (!newAdmin) throw new Error("Administrador do banco novo não encontrado");

  const userMap = new Map();
  let createdUsers = 0;
  for (const profile of profiles) {
    if (profile.full_name === "Administrador" && nullable(profile.registration) === null) {
      userMap.set(profile.id, newAdmin.id);
      continue;
    }

    let newUserId = byRegistration.get(profile.registration);
    if (!newUserId) {
      const created = await request("/functions/v1/create-employee", {
        method: "POST",
        token,
        body: {
          registration: profile.registration,
          fullName: profile.full_name,
          sector: profile.sector,
          password: "claro123",
        },
      });
      newUserId = created.userId;
      byRegistration.set(profile.registration, newUserId);
      createdUsers += 1;
    }
    userMap.set(profile.id, newUserId);
  }

  await request("/rest/v1/holidays?on_conflict=id", {
    method: "POST",
    token,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: holidays.map((item) => ({
      id: item.id,
      name: item.name,
      date: item.date,
      is_national: bool(item.is_national),
      created_at: item.created_at,
    })),
  });

  for (let index = 0; index < vacationHistory.length; index += 50) {
    await request("/rest/v1/vacation_history?on_conflict=id", {
      method: "POST",
      token,
      prefer: "resolution=merge-duplicates,return=minimal",
      body: vacationHistory.slice(index, index + 50).map((item) => ({
        id: item.id,
        user_id: userMap.get(item.user_id),
        year: Number(item.year),
        start_date: item.start_date,
        end_date: item.end_date,
        is_critical_period: bool(item.is_critical_period),
        notes: nullable(item.notes),
        created_at: item.created_at,
        updated_at: item.created_at,
      })),
    });
  }

  let importedRequests = 0;
  let migratedConflictsToHistory = 0;
  const failedRequests = [];
  const currentRequests = await request("/rest/v1/vacation_requests?select=id", { token });
  const existingRequestIds = new Set(currentRequests.map((item) => item.id));
  for (const item of vacationRequests.sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    if (existingRequestIds.has(item.id)) {
      importedRequests += 1;
      continue;
    }
    const legacyThirdPeriod = Number(item.period_number) === 3;
    const legacyNote = legacyThirdPeriod ? "[Migrado: período original 3]" : "";
    const adminNotes = [legacyNote, nullable(item.admin_notes)].filter(Boolean).join(" ") || null;
    try {
      await request("/rest/v1/vacation_requests", {
        method: "POST",
        token,
        prefer: "return=minimal",
        body: {
          id: item.id,
          user_id: userMap.get(item.user_id),
          period_number: legacyThirdPeriod ? 2 : Number(item.period_number),
          start_date: item.start_date,
          end_date: item.end_date,
          duration_days: Number(item.duration_days),
          status: item.status,
          admin_notes: adminNotes,
          rejection_reason: nullable(item.rejection_reason),
          wants_thirteenth_advance: bool(item.wants_thirteenth_advance),
          wants_abono: bool(item.wants_abono),
          abono_days: nullable(item.abono_days) === null ? null : Number(item.abono_days),
          is_launched: bool(item.is_launched),
          launched_at: nullable(item.launched_at),
          created_at: item.created_at,
          updated_at: item.updated_at,
        },
      });
      importedRequests += 1;
    } catch (error) {
      if (item.status === "approved" && error.message.includes("sobreposição superior a 3 dias")) {
        await request("/rest/v1/vacation_history?on_conflict=id", {
          method: "POST",
          token,
          prefer: "resolution=merge-duplicates,return=minimal",
          body: {
            id: item.id,
            user_id: userMap.get(item.user_id),
            year: Number(item.start_date.slice(0, 4)),
            start_date: item.start_date,
            end_date: item.end_date,
            is_critical_period: false,
            notes: `[Migrado de marcação aprovada; mantido no histórico porque conflita com a regra atual de sobreposição.] ${adminNotes ?? ""}`.trim(),
            created_at: item.created_at,
            updated_at: item.updated_at,
          },
        });
        migratedConflictsToHistory += 1;
      } else {
        failedRequests.push({ id: item.id, error: error.message });
      }
    }
  }

  const [destinationProfiles, destinationRequests, destinationHistory, destinationHolidays] = await Promise.all([
    request("/rest/v1/profiles?select=id", { token }),
    request("/rest/v1/vacation_requests?select=id", { token }),
    request("/rest/v1/vacation_history?select=id", { token }),
    request("/rest/v1/holidays?select=id", { token }),
  ]);

  console.log(JSON.stringify({
    profiles: profiles.length,
    createdUsers,
    vacationRequests: vacationRequests.length,
    importedRequests,
    migratedConflictsToHistory,
    failedRequests,
    vacationHistory: vacationHistory.length,
    holidays: holidays.length,
    destination: {
      profiles: destinationProfiles.length,
      vacationRequests: destinationRequests.length,
      vacationHistory: destinationHistory.length,
      holidays: destinationHolidays.length,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
