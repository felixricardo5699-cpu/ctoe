import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_MAX_BODY_BYTES } from '@shared/types/bridge'
import {
  BridgePortUnavailableError,
  isLoopbackHost,
  startBridgeServer,
  type BridgeHttpRequest,
  type BridgeHttpResponse,
  type BridgeServer
} from './localBridgeServer'

/*
 * The listener, driven over a real socket.
 *
 * Every one of these goes through Node's HTTP client rather than a stubbed stream, because the
 * things worth proving here - which Host a request arrived with, what headers came back, whether
 * an over-large body is refused - only exist once something is actually speaking HTTP.
 */

const servers: BridgeServer[] = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server !== undefined) await server.close()
  }
})

/** Binds a random free port, so a test run never collides with a real app or another test. */
async function serve(route: (request: BridgeHttpRequest) => BridgeHttpResponse): Promise<number> {
  const server = await startBridgeServer(route, [0])
  servers.push(server)
  return server.port
}

interface RawAnswer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * One request, sent the way a real client sends one - Host and all.
 *
 * The Host is written by hand rather than left to Node so a test about which host a request was
 * addressed to can override it; it is always present otherwise, because an HTTP/1.1 request
 * without one never reaches a route (the server rejects it while parsing).
 */
function raw(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/v1/health',
        headers: { host: '127.0.0.1:' + String(port), ...(options.headers ?? {}) },
        setHost: false
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
        )
      }
    )
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

const okBody = { status: 200, body: { ok: true } }
const echoRequest = (request: BridgeHttpRequest): BridgeHttpResponse => ({
  status: 200,
  body: { path: request.path, method: request.method, body: request.body ?? null }
})

describe('bridge server: which host a request is addressed to', () => {
  it('accepts the names that really are this machine', () => {
    expect(isLoopbackHost('127.0.0.1:43110')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost:43110')).toBe(true)
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('[::1]:43110')).toBe(true)
  })

  it('refuses anything else, which is the point of the check', () => {
    // A page can point a hostname it controls at 127.0.0.1; such a request arrives saying so.
    expect(isLoopbackHost('evil.example.com')).toBe(false)
    expect(isLoopbackHost('evil.example.com:43110')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.example.com')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
    expect(isLoopbackHost(undefined)).toBe(false)
  })

  it('answers a request addressed elsewhere with a refusal rather than a service', async () => {
    const port = await serve(echoRequest)

    const answer = await raw(port, { headers: { host: 'evil.example.com:43110' } })

    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('serves the same request when it is addressed to the loopback interface', async () => {
    const port = await serve(echoRequest)

    const answer = await raw(port, { headers: { host: '127.0.0.1:' + String(port) } })

    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).path).toBe('/v1/health')
  })
})

describe('bridge server: the shape of the exchange', () => {
  it('hands a route the path with the query string already gone', async () => {
    const port = await serve(echoRequest)

    const answer = await raw(port, { path: '/v1/learn?x=1' })

    expect(JSON.parse(answer.body).path).toBe('/v1/learn')
  })

  it('refuses a path that tries to walk out of the routes it serves', async () => {
    const port = await serve(echoRequest)

    // Not a route this protocol has, and not one anything here resolves; refusing it in the
    // transport keeps the routing table from having to think about path traversal at all.
    const answer = await raw(port, { path: '/v1/../etc/passwd' })

    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body).error).toBe('not-found')
  })

  it('parses a JSON body and hands it over', async () => {
    const port = await serve(echoRequest)

    const answer = await raw(port, {
      method: 'POST',
      path: '/v1/learn',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r1' })
    })

    expect(JSON.parse(answer.body).body).toEqual({ requestId: 'r1' })
  })

  it('refuses a body that is not JSON at all', async () => {
    const port = await serve(echoRequest)

    const answer = await raw(port, { method: 'POST', path: '/v1/learn', body: 'not json' })

    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body).error).toBe('bad-json')
  })

  it('refuses a body past the ceiling instead of holding it', async () => {
    const port = await serve(echoRequest)

    const answer = await raw(port, {
      method: 'POST',
      path: '/v1/learn',
      body: 'x'.repeat(BRIDGE_MAX_BODY_BYTES + 1024)
    })

    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body).error).toBe('bad-json')
  })

  it('answers a preflight without troubling the route, and says what may be sent', async () => {
    let called = 0
    const port = await serve((request) => {
      called += 1
      return echoRequest(request)
    })

    const answer = await raw(port, {
      method: 'OPTIONS',
      path: '/v1/learn',
      headers: { origin: 'chrome-extension://abc', 'access-control-request-method': 'POST' }
    })

    expect(answer.status).toBe(204)
    expect(answer.body).toBe('')
    expect(called).toBe(0)
    expect(answer.headers['access-control-allow-origin']).toBe('chrome-extension://abc')
    expect(answer.headers['access-control-allow-headers']).toContain('authorization')
    expect(answer.headers['access-control-allow-private-network']).toBe('true')
  })

  it('echoes the headers a preflight announced rather than a list of its own', async () => {
    const port = await serve(() => okBody)

    const answer = await raw(port, {
      method: 'OPTIONS',
      path: '/v1/learn',
      headers: {
        origin: 'chrome-extension://abc',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-ctoe-protocol,authorization'
      }
    })

    expect(answer.status).toBe(204)
    // Verbatim: the protocol keeps growing headers, and a copy of the list here would go stale.
    expect(answer.headers['access-control-allow-headers']).toBe('x-ctoe-protocol,authorization')
  })

  it('names the headers the protocol settles on when a preflight announced none', async () => {
    const port = await serve(() => okBody)

    const answer = await raw(port, {
      method: 'OPTIONS',
      path: '/v1/learn',
      headers: { origin: 'chrome-extension://abc', 'access-control-request-method': 'POST' }
    })

    expect(answer.headers['access-control-allow-headers']).toBe('authorization, content-type')
  })

  it('falls back instead of repeating back a header list it should not', async () => {
    const port = await serve(() => okBody)
    const announced = {
      origin: 'chrome-extension://abc',
      'access-control-request-method': 'POST'
    }

    // Latin-1, so Node's own client will send it; what matters is that the answer does not.
    const nonAscii = await raw(port, {
      method: 'OPTIONS',
      path: '/v1/learn',
      headers: { ...announced, 'access-control-request-headers': 'x-ctoe-\u00e9' }
    })
    const overlong = await raw(port, {
      method: 'OPTIONS',
      path: '/v1/learn',
      headers: { ...announced, 'access-control-request-headers': 'x'.repeat(513) }
    })

    expect(nonAscii.headers['access-control-allow-headers']).toBe('authorization, content-type')
    expect(overlong.headers['access-control-allow-headers']).toBe('authorization, content-type')
  })

  it('echoes the origin back rather than answering with a wildcard', async () => {
    const port = await serve(() => okBody)

    const answer = await raw(port, { headers: { origin: 'chrome-extension://abc' } })

    expect(answer.headers['access-control-allow-origin']).toBe('chrome-extension://abc')
    expect(answer.headers['access-control-allow-origin']).not.toBe('*')
    // Without Vary, a cache could hand one origin's answer to another.
    expect(answer.headers.vary).toBe('Origin')
    expect(answer.headers['cache-control']).toBe('no-store')
  })

  it('writes no CORS permission when the request named no origin', async () => {
    const port = await serve(() => okBody)

    const answer = await raw(port)

    expect(answer.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('reports a route that threw as a failure of this app', async () => {
    const port = await serve(() => {
      throw new Error('route blew up')
    })

    const answer = await raw(port)

    expect(answer.status).toBe(500)
    expect(JSON.parse(answer.body)).toEqual({ ok: false, error: 'internal' })
  })
})

describe('bridge server: choosing a port', () => {
  it('takes the first port in the range that is free', async () => {
    const first = await startBridgeServer(echoRequest, [0])
    servers.push(first)
    // The same port is now taken, so a second server must move to the next one offered.
    const second = await startBridgeServer(echoRequest, [first.port, 0])
    servers.push(second)

    expect(second.port).not.toBe(first.port)
    expect(second.port).toBeGreaterThan(0)
  })

  it('says so plainly when every port it was given is taken', async () => {
    const first = await startBridgeServer(echoRequest, [0])
    servers.push(first)

    await expect(startBridgeServer(echoRequest, [first.port])).rejects.toBeInstanceOf(
      BridgePortUnavailableError
    )
  })
})
