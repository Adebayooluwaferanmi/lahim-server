import 'fastify'
declare module 'fastify' {
  interface FastifyBaseLogger {
    debug(...args: any[]): void
    info(...args: any[]): void
    warn(...args: any[]): void
    error(...args: any[]): void
  }
}
