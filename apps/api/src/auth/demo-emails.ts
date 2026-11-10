/**
 * E-mails das contas da demo pública (README). Ficam em auth/ porque o login os
 * isenta do limite por e-mail; jobs/demo-data.ts monta as contas a partir daqui.
 */
export const DEMO_EMAILS = {
  admin: 'admin@demo.example.com',
  agent: 'agente@demo.example.com',
  customer: 'cliente@demo.example.com',
} as const;
