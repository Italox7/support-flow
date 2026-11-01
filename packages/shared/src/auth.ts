import type { Role } from './enums.js';

/** Usuário como a API o expõe: nunca inclui o hash da senha. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * Resposta de register, login e refresh. O refresh token não aparece aqui: ele
 * vai só no cookie httpOnly, fora do alcance do JavaScript da página.
 */
export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}
