import { FastifyInstance, FastifyError } from 'fastify'
import proxy from '@fastify/http-proxy'

interface Options {
  url: string
}

export function couchDBProxy(
  fastify: FastifyInstance,
  options: Options,
  next: (err?: FastifyError | undefined) => void,
) {
  fastify.register(proxy, {
    upstream: options.url,
    prefix: '/_db',
    rewritePrefix: '/_db',
  })
  next()
}
