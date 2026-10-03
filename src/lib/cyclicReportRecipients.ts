export const CYCLIC_REPORT_DEFAULT_TO = "martha.barrera@gpc.pe";

export const CYCLIC_REPORT_DEFAULT_CC = [
  "rociodelacruz@gpc.pe",
  "felipe.cabellos@gpc.pe",
  "marisol.vargas@gpc.pe",
  "malu.ccahuantico@gpc.pe",
  "loraine.palacio@gpc.pe",
  "sarita.romero@gpc.pe",
  "yolanda.morales@gpc.pe",
];

export const CYCLIC_REPORT_REQUIRED_CC = "yolanda.morales@gpc.pe";

export function parseCyclicReportRecipients(configured: string | string[]): string[] {
  const values = Array.isArray(configured) ? configured : configured.split(/[;,\n]/);
  return [...new Set(values.map(email => email.trim().toLowerCase()).filter(Boolean))];
}

export function cyclicReportCcRecipients(configuredCc: string | string[]): string {
  return parseCyclicReportRecipients([
    ...parseCyclicReportRecipients(configuredCc),
    CYCLIC_REPORT_REQUIRED_CC,
  ]).join(",");
}
