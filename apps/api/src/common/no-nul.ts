import { ValidateBy } from 'class-validator';

/**
 * O Postgres não guarda o caractere NUL (U+0000) em colunas de texto: o
 * INSERT falha (22021) e a API devolveria 500. Barrado na validação, vira 400.
 * Só o NUL: os outros caracteres de controle são aceitos pelo banco, e `\n`
 * faz parte de descrições e comentários. Valor que não é string fica com o
 * `@IsString` do campo.
 */
export const NoNul = () =>
  ValidateBy({
    name: 'noNul',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || !value.includes('\u0000'),
      defaultMessage: () => '$property não pode conter o caractere NUL',
    },
  });
