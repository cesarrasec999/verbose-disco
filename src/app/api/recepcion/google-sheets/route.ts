export const runtime = "nodejs";

type StorePayload = {
  code?: string | null;
  erp_sede?: string | null;
  name?: string | null;
};

type ReceptionPayload = {
  requestIds?: string[];
  document?: string | null;
  destinationStoreCode?: string | null;
  destinationStoreName?: string | null;
  sourceStoreCode?: string | null;
  sourceStoreName?: string | null;
  completedAt?: string | null;
  completedByName?: string | null;
  stores?: StorePayload[];
  rows?: {
    lineId?: string | null;
    productCode?: string | null;
    description?: string | null;
    unit?: string | null;
    requestedQty?: number | null;
    receivedQty?: number | null;
    difference?: number | null;
    notes?: string | null;
  }[];
};

type SheetProperties = {
  sheetId: number;
  title: string;
  index?: number;
};

const DEFAULT_SPREADSHEET_ID = "1HcIfilt-WV7QpAVcd345ffXfoYQ7kret";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const HEADERS = [
  "Fecha cierre",
  "Tienda destino",
  "Codigo tienda",
  "Documento",
  "Origen",
  "Producto",
  "Descripcion",
  "UM",
  "Enviado",
  "Recibido",
  "Diferencia",
  "Observacion",
  "Operador",
  "Sync key",
];

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function getSpreadsheetId() {
  return process.env.RECEPTION_DIFFERENCES_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
}

function getPrivateKey() {
  return (process.env.GOOGLE_SHEETS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

async function getAccessToken() {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const privateKey = getPrivateKey();
  if (!clientEmail || !privateKey) {
    throw new Error("Faltan GOOGLE_SHEETS_CLIENT_EMAIL y GOOGLE_SHEETS_PRIVATE_KEY.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const unsigned = `${header}.${claim}`;
  const { createSign } = await import("node:crypto");
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "No se pudo autenticar con Google.");
  return String(payload.access_token);
}

async function sheetsFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${getSpreadsheetId()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error_description || "Error de Google Sheets.";
    throw new Error(message);
  }
  return payload as T;
}

function normalizeText(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
}

function safeSheetTitle(value: string | null | undefined) {
  return String(value || "Recepciones")
    .replace(/[:\\/?*\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Recepciones";
}

function findUniqueStoreMatch(title: string, stores: StorePayload[]) {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) return null;

  const matches = stores.filter(store => {
    const storeName = normalizeText(store.name);
    const codes = [store.code, store.erp_sede].map(normalizeText).filter(Boolean);
    if (codes.includes(normalizedTitle)) return true;
    if (storeName && normalizedTitle.length >= 4 && storeName.startsWith(normalizedTitle)) return true;
    if (storeName && normalizedTitle.length >= 6 && storeName.includes(normalizedTitle)) return true;
    return false;
  });

  return matches.length === 1 ? matches[0] : null;
}

async function getSheets(accessToken: string) {
  const metadata = await sheetsFetch<{ sheets?: { properties: SheetProperties }[] }>(
    accessToken,
    "?fields=sheets.properties(sheetId,title,index)"
  );
  return (metadata.sheets || []).map(sheet => sheet.properties);
}

async function batchUpdate(accessToken: string, requests: unknown[]) {
  if (requests.length === 0) return;
  await sheetsFetch(accessToken, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

async function renameKnownStoreSheets(accessToken: string, sheets: SheetProperties[], stores: StorePayload[]) {
  if (stores.length === 0) return sheets;
  const usedTitles = new Set(sheets.map(sheet => normalizeText(sheet.title)));
  const requests: unknown[] = [];

  for (const sheet of sheets) {
    const match = findUniqueStoreMatch(sheet.title, stores);
    const nextTitle = safeSheetTitle(match?.name);
    if (!match?.name || normalizeText(sheet.title) === normalizeText(nextTitle) || usedTitles.has(normalizeText(nextTitle))) continue;
    usedTitles.delete(normalizeText(sheet.title));
    usedTitles.add(normalizeText(nextTitle));
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sheet.sheetId, title: nextTitle },
        fields: "title",
      },
    });
    sheet.title = nextTitle;
  }

  await batchUpdate(accessToken, requests);
  return sheets;
}

async function ensureDestinationSheet(accessToken: string, payload: ReceptionPayload) {
  let sheets = await getSheets(accessToken);
  sheets = await renameKnownStoreSheets(accessToken, sheets, payload.stores || []);

  const desiredTitle = safeSheetTitle(payload.destinationStoreName || payload.destinationStoreCode || "Recepciones");
  const desiredKey = normalizeText(desiredTitle);
  const exact = sheets.find(sheet => normalizeText(sheet.title) === desiredKey);
  if (exact) return exact.title;

  const destinationMatch = sheets.find(sheet => {
    const key = normalizeText(sheet.title);
    const code = normalizeText(payload.destinationStoreCode);
    return (code && key === code) || (key.length >= 4 && desiredKey.startsWith(key));
  });
  if (destinationMatch) {
    await batchUpdate(accessToken, [{
      updateSheetProperties: {
        properties: { sheetId: destinationMatch.sheetId, title: desiredTitle },
        fields: "title",
      },
    }]);
    return desiredTitle;
  }

  await batchUpdate(accessToken, [{ addSheet: { properties: { title: desiredTitle } } }]);
  return desiredTitle;
}

function sheetRange(title: string, range: string) {
  return `'${title.replace(/'/g, "''")}'!${range}`;
}

async function ensureHeader(accessToken: string, title: string) {
  const current = await sheetsFetch<{ values?: string[][] }>(
    accessToken,
    `/values/${encodeURIComponent(sheetRange(title, "A1:N1"))}?majorDimension=ROWS`
  );
  if ((current.values?.[0] || []).some(Boolean)) return;
  await sheetsFetch(accessToken, `/values/${encodeURIComponent(sheetRange(title, "A1:N1"))}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values: [HEADERS] }),
  });
}

async function readExistingKeys(accessToken: string, title: string) {
  const current = await sheetsFetch<{ values?: string[][] }>(
    accessToken,
    `/values/${encodeURIComponent(sheetRange(title, "N2:N"))}?majorDimension=COLUMNS`
  );
  return new Set((current.values?.[0] || []).map(String).filter(Boolean));
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ReceptionPayload;
    const accessToken = await getAccessToken();
    const sheetTitle = await ensureDestinationSheet(accessToken, payload);
    await ensureHeader(accessToken, sheetTitle);

    const existingKeys = await readExistingKeys(accessToken, sheetTitle);
    const completedAt = payload.completedAt || new Date().toISOString();
    const rows = (payload.rows || [])
      .filter(row => Number(row.difference || 0) !== 0)
      .map(row => {
        const syncKey = `${payload.requestIds?.join("+") || payload.document || "recepcion"}:${row.lineId || row.productCode}`;
        return {
          syncKey,
          values: [
            completedAt,
            payload.destinationStoreName || "",
            payload.destinationStoreCode || "",
            payload.document || "",
            payload.sourceStoreName || payload.sourceStoreCode || "",
            row.productCode || "",
            row.description || "",
            row.unit || "",
            Number(row.requestedQty || 0),
            Number(row.receivedQty || 0),
            Number(row.difference || 0),
            row.notes || "",
            payload.completedByName || "",
            syncKey,
          ],
        };
      })
      .filter(row => !existingKeys.has(row.syncKey));

    if (rows.length > 0) {
      await sheetsFetch(accessToken, `/values/${encodeURIComponent(sheetRange(sheetTitle, "A:N"))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: "POST",
        body: JSON.stringify({ values: rows.map(row => row.values) }),
      });
    }

    return Response.json({ ok: true, sheetTitle, appended: rows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
