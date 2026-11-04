/**
 * Marca o 503 do lock da atribuição, em que nada foi gravado. O front só repete
 * sozinho com este código: um 503 de proxy pode vir depois de a API já ter gravado.
 */
export const ASSIGNMENT_BUSY_CODE = 'ASSIGNMENT_BUSY';
