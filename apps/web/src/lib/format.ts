const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const time = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' });

export const formatDateTime = (value: string | number) => dateTime.format(new Date(value));
export const formatDate = (value: string | number) => date.format(new Date(value));
export const formatTime = (value: string | number) => time.format(new Date(value));
