/**
 * Marca o 503 do lock da atribuição, em que nada foi gravado. O front só repete
 * sozinho com este código: um 503 de proxy pode vir depois de a API já ter gravado.
 */
export const ASSIGNMENT_BUSY_CODE = 'ASSIGNMENT_BUSY';

/**
 * Marca o 503 da fila do hash de senha cheia: o hash vem antes de qualquer escrita,
 * então nada foi gravado. O front NÃO repete sozinho: com a fila cheia, repetir
 * só aumenta a carga. Quem decide tentar de novo é a pessoa.
 */
export const PASSWORD_HASH_BUSY_CODE = 'PASSWORD_HASH_BUSY';
