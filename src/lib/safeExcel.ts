import * as XLSX from "xlsx";

type SafeExcelOptions = {
  maxBytes?: number;
  maxRows?: number;
  maxCols?: number;
  raw?: boolean;
};

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 25000;
const DEFAULT_MAX_COLS = 80;
const ALLOWED_EXTENSIONS = new Set([".csv", ".xls", ".xlsx"]);

function extensionFor(fileName: string) {
  const match = fileName.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] || "";
}

function validateExcelFile(file: File, options: SafeExcelOptions) {
  const extension = extensionFor(file.name);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("Archivo no permitido. Usa .xlsx, .xls o .csv.");
  }
  if (file.size <= 0) {
    throw new Error("El archivo esta vacio.");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (file.size > maxBytes) {
    throw new Error(`El archivo pesa demasiado. Maximo permitido: ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
}

function validateExcelBuffer(fileName: string, byteLength: number, options: SafeExcelOptions) {
  const extension = extensionFor(fileName);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("Archivo no permitido. Usa .xlsx, .xls o .csv.");
  }
  if (byteLength <= 0) {
    throw new Error("El archivo esta vacio.");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (byteLength > maxBytes) {
    throw new Error(`El archivo pesa demasiado. Maximo permitido: ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
}

function workbookFirstSheet(workbook: XLSX.WorkBook) {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("El archivo no tiene hojas.");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error("No se pudo leer la primera hoja del archivo.");
  return sheet;
}

function assertSafeSheet(sheet: XLSX.WorkSheet, options: SafeExcelOptions) {
  const ref = sheet["!ref"];
  if (!ref) throw new Error("La primera hoja esta vacia.");

  const range = XLSX.utils.decode_range(ref);
  const totalRows = range.e.r - range.s.r + 1;
  const totalCols = range.e.c - range.s.c + 1;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCols = options.maxCols ?? DEFAULT_MAX_COLS;

  if (totalRows > maxRows) {
    throw new Error(`El archivo tiene ${totalRows.toLocaleString("es-PE")} filas. Maximo permitido: ${maxRows.toLocaleString("es-PE")}.`);
  }
  if (totalCols > maxCols) {
    throw new Error(`El archivo tiene ${totalCols.toLocaleString("es-PE")} columnas. Maximo permitido: ${maxCols.toLocaleString("es-PE")}.`);
  }

  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const cell = sheet[key] as XLSX.CellObject | undefined;
    if (cell?.f) {
      throw new Error("El archivo contiene formulas. Pega valores y vuelve a cargarlo.");
    }
  }
}

async function readFirstSafeSheet(file: File, options: SafeExcelOptions = {}) {
  validateExcelFile(file, options);
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellFormula: true,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    WTF: false,
  });
  const sheet = workbookFirstSheet(workbook);
  assertSafeSheet(sheet, options);
  return sheet;
}

async function readFirstSafeSheetFromBuffer(buffer: ArrayBuffer, fileName: string, options: SafeExcelOptions = {}) {
  validateExcelBuffer(fileName, buffer.byteLength, options);
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellFormula: true,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    WTF: false,
  });
  const sheet = workbookFirstSheet(workbook);
  assertSafeSheet(sheet, options);
  return sheet;
}

export async function readSafeSheetMatrix(file: File, options: SafeExcelOptions = {}) {
  const sheet = await readFirstSafeSheet(file, options);
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    defval: "",
    raw: options.raw ?? false,
    header: 1,
  });
}

export async function readSafeSheetMatrixFromBuffer(buffer: ArrayBuffer, fileName: string, options: SafeExcelOptions = {}) {
  const sheet = await readFirstSafeSheetFromBuffer(buffer, fileName, options);
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    defval: "",
    raw: options.raw ?? false,
    header: 1,
  });
}

export async function readSafeSheetObjects<T extends Record<string, unknown> = Record<string, unknown>>(
  file: File,
  options: SafeExcelOptions = {}
) {
  const sheet = await readFirstSafeSheet(file, options);
  return XLSX.utils.sheet_to_json<T>(sheet, {
    defval: "",
    raw: options.raw ?? false,
  });
}
