import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BRIDGE_HOST, BRIDGE_MAX_BODY_BYTES, BRIDGE_PORTS } from '@shared/types/bridge'

/*
 * The loopback listener the browser extension talks to.
 *
 * Three things it does, and nothing else: it binds the loopback interface, it decides whether a
 * request is even addressed to this app, and it turns bytes into a parsed body and a JSON answer.
 * What a request *means* is the caller's business - this file has no idea what Learn is, which is
 * what lets the routing be tested with a stub while the server is tested on a real port.
 *
 * The loopback interface is not a security boundary on its own: any page the user has open, and
 * any other program on the machine, can reach 127.0.0.1. So the checks below are about who is
 * allowed to *ask*, and the token check that follows is about who is allowed to *act*.
 */

/** What a route is handed: the parts of a request that can matter, and nothing of Node's. */
export interface BridgeHttpRequest {
  method: string
  /** The path with no query string, e.g. '/v1/learn'. */
  path: string
  headers: Record<string, string | undefined>
  /** The parsed JSON body, or null when there was none. A body that is not JSON is a refusal. */
  body: unknown
}

/** What a route hands back. The body is serialised as JSON with the bridge's CORS headers. */
export interface BridgeHttpResponse {
  status: number
  body: unknown
}

export type BridgeRoute = (request: BridgeHttpRequest) => BridgeHttpResponse | Promise<BridgeHttpResponse>

export interface BridgeServer {
  port: number
  /** Stops listening. Safe to call twice; a server that is already down is already down. */
  close(): Promise<void>
}

/** Every port was taken, so there is nowhere for the bridge to listen. */
export class BridgePortUnavailableError extends Error {
  constructor(readonly tried: readonly number[]) {
    super('no bridge port was free: ' + tried.join(', '))
    this.name = 'BridgePortUnavailableError'
  }
}

/**
 * Binds the first free port in the range and answers there.
 *
 * The range, not one fixed port, is what keeps this working when something else already holds the
 * first choice - and because the extension probes the same list in the same order, the two ends
 * find each other without the user being asked which port to use.
 */
export async function startBridgeServer(
  route: BridgeRoute,
  ports: readonly number[] = BRIDGE_PORTS
): Promise<BridgeServer> {
  for (const port of ports) {
    const server = createServer((request, response) => {
      void handle(route, request, response)
    })
    // A request held open would keep the app from quitting; the ceiling is generous but finite.
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    // The port that was actually bound, which is the requested one unless 0 was asked for.
    const bound = await listen(server, port)
    if (bound !== null) {
      return {
        port: bound,
        close: () => close(server)
      }
    }
  }
  throw new BridgePortUnavailableError(ports)
}

/**
 * Binds one port. The number it actually holds is the answer, or null when that port belongs to
 * someone else already - which is the signal to try the next one rather than a failure.
 *
 * A port of 0 means "any free port", which is what the tests ask for so a run never collides with
 * a real app or another test.
 */
function listen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(null)
      else reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, BRIDGE_HOST)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

async function handle(
  route: BridgeRoute,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? 'GET'
  const caller = readCaller(request)

  // A preflight is answered here rather than by a route: it is about the transport, and letting
  // it through would mean teaching every route about CORS.
  if (method === 'OPTIONS') {
    writeResponse(response, 204, null, caller)
    return
  }

  if (!isLoopbackHost(readHeader(request, 'host'))) {
    // Something is addressing this server by a name that is not the loopback interface, which is
    // the one thing a page on the internet can do that this app must not answer.
    writeResponse(response, 403, { ok: false, error: 'unauthorized' }, caller)
    return
  }

  const path = readPath(request.url)
  if (path === null) {
    writeResponse(response, 404, { ok: false, error: 'not-found' }, caller)
    return
  }

  const read = await readBody(request)
  if (read.kind === 'too-large') {
    // The ceiling exists so one request cannot make the app hold an unbounded string; a body
    // that big is not the JSON this protocol describes.
    writeResponse(response, 400, { ok: false, error: 'bad-json' }, caller)
    return
  }
  if (read.kind === 'unreadable') {
    writeResponse(response, 400, { ok: false, error: 'bad-json' }, caller)
    return
  }

  // A request with no body at all is normal for the two GETs, so it is handed over as null and
  // the route decides whether it needed one.
  const body: unknown = read.kind === 'ok' ? read.body : null

  let answer: BridgeHttpResponse
  try {
    answer = await route({ method, path, headers: flattenHeaders(request), body })
  } catch {
    // A route that threw is a bug in this app, not something an extension can fix - so it is
    // reported in the protocol's own words instead of taking the connection down.
    answer = { status: 500, body: { ok: false, error: 'internal' } }
  }
  writeResponse(response, answer.status, answer.body, caller)
}

type BodyRead =
  | { kind: 'ok'; body: unknown }
  | { kind: 'empty' }
  | { kind: 'too-large' }
  | { kind: 'unreadable' }

/**
 * Reads the body to a ceiling and parses it. A GET has none; a POST without one, or with a body
 * that is not JSON, is reported as such rather than treated as an empty request.
 */
function readBody(request: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: BodyRead): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk: Buffer) => {
      // Once the answer is decided the rest of the body is discarded rather than buffered: a
      // client that keeps sending must not be able to make this app hold the overflow.
      if (settled) return
      size += chunk.length
      if (size > BRIDGE_MAX_BODY_BYTES) {
        finish({ kind: 'too-large' })
        return
      }
      chunks.push(chunk)
    })
    request.on('error', () => finish({ kind: 'unreadable' }))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        finish({ kind: 'empty' })
        return
      }
      try {
        finish({ kind: 'ok', body: JSON.parse(text) as unknown })
      } catch {
        finish({ kind: 'unreadable' })
      }
    })
  })
}

/**
 * Whether a Host header names this machine's loopback interface.
 *
 * A page on the internet can make a browser send a request here by pointing a hostname it controls
 * at 127.0.0.1, which is what DNS rebinding is. Such a request arrives with that hostname in the
 * Host header, so refusing anything that is not loopback by name closes it. The port is ignored:
 * the app answers on whichever port it managed to bind.
 */
export function isLoopbackHost(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false
  const withoutPort = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : (value.split(':')[0] ?? '')
  const host = withoutPort.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

/** The path with the query string dropped, or null when it is not a path this server can route. */
function readPath(url: string | undefined): string | null {
  if (url === undefined) return null
  const withoutQuery = url.split('?')[0] ?? ''
  // A traversal or an absolute-form request is not something this protocol ever produces.
  if (!withoutQuery.startsWith('/') || withoutQuery.includes('..')) return null
  return withoutQuery.length > 1 && withoutQuery.endsWith('/')
    ? withoutQuery.slice(0, -1)
    : withoutQuery
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

function flattenHeaders(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value
  }
  return headers
}

/**
 * What a response has to know about the caller to answer its CORS questions.
 *
 * The two travel together - an origin with no list of headers is still a caller to answer - so
 * they are read once at the top and handed on as one thing rather than threaded separately
 * through every branch.
 */
interface Caller {
  /** The caller's origin. Echoed back, since a browser only lets its owner read the answer. */
  origin: string | undefined
  /** The headers the caller announced it will send, echoed back on a preflight. */
  askedHeaders: string | undefined
}

function readCaller(request: IncomingMessage): Caller {
  return {
    origin: readHeader(request, 'origin'),
    askedHeaders: readAskedHeaders(readHeader(request, 'access-control-request-headers'))
  }
}

/** Longest list of headers this app will repeat back. A browser writes a short one. */
const MAX_ASKED_HEADERS_CHARS = 512

/**
 * The header list a preflight is answered with, or undefined when the value is not one.
 *
 * This is the only value from a request that is repeated into a response, so it is checked rather
 * than trusted: printable ASCII and within a short ceiling, or nothing. Falling back costs one
 * answer that names the protocol's own two headers, and the check is here rather than left to Node
 * because Node refuses to write a value carrying a control character - a refusal there would be a
 * failed response instead of a slightly wrong one.
 */
function readAskedHeaders(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  if (value.length > MAX_ASKED_HEADERS_CHARS) return undefined
  return /^[\x20-\x7e]+$/.test(value) ? value : undefined
}

/**
 * What a preflight is answered with when the caller did not say which headers it will send. These
 * are the two the protocol settles on by itself, so the answer stays useful rather than empty.
 */
const DEFAULT_ALLOWED_HEADERS = 'authorization, content-type'

/**
 * Writes a JSON answer with the headers the browser needs to let the extension read it.
 *
 * The origin is echoed back rather than answered with a wildcard: the extension's own origin is
 * chrome-extension://<an id the app does not know at build time>, so echoing is what makes it
 * work - and echoing is also what a wildcard would *not* be, since a wildcard would let any page
 * read the answers too. Vary keeps a caching layer from handing one origin's answer to another.
 *
 * Private-network access is granted explicitly because a request from a page to a loopback
 * address is exactly what Chrome asks about; the extension's own requests are not subject to it,
 * but a policy that only says yes when asked is cheaper than being wrong later.
 *
 * The headers the caller announced are echoed rather than checked against a list of this app's
 * own. That list is the protocol, which is still growing, and a hard-coded copy of it is one that
 * silently stops being true - which is exactly what the list this replaces did. What the list
 * decides is only whether the browser passes a request on to the token check; it grants nothing
 * that check does not already decide.
 */
function writeResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
  caller: Caller
): void {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    'Access-Control-Allow-Private-Network': 'true'
  }
  if (caller.origin !== undefined && caller.origin.length > 0) {
    headers['Access-Control-Allow-Origin'] = caller.origin
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = caller.askedHeaders ?? DEFAULT_ALLOWED_HEADERS
    headers['Access-Control-Max-Age'] = '600'
  }
  if (status === 204 || body === null) {
    response.writeHead(status, headers)
    response.end()
    return
  }
  headers['Content-Type'] = 'application/json; charset=utf-8'
  response.writeHead(status, headers)
  response.end(JSON.stringify(body))
}
