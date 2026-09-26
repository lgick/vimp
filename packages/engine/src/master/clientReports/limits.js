// Длины полей журнала клиентских ошибок (plan/client-reports): одни и те же
// на приёме от браузера и при санитайзе записи для auth-сервиса
export const MESSAGE = 500;
// сырой стек от клиента
export const STACK = 4000;
// стек после расшифровки source maps (этап 4) длиннее минифицированного
export const STACK_SYMBOLICATED = 8000;
export const CODE = 64;
export const DETAILS_BYTES = 2048;
export const USER_AGENT = 256;
export const PAGE = 128;
export const SESSION_ID = 64;
