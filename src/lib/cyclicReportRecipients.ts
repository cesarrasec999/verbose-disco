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

export function cyclicReportCcRecipients(configuredCc: string): string {
  return [...new Set(
    `${configuredCc},${CYCLIC_REPORT_REQUIRED_CC}`
      .split(",")
      .map(email => email.trim().toLowerCase())
      .filter(Boolean),
  )].join(",");
}
