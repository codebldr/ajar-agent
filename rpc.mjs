// The intercom's other API.
//
// Dahua devices answer JSON-RPC over plain HTTP at `/RPC2_Login` and then `/RPC2` — the same
// interface the manufacturer's app reaches over its binary port, with none of the binary. Most
// of what this agent needs is on the CGI side, so this exists for the one thing that is not:
// hanging up a call.
//
// It is needed because the gate speaker belongs to a call while one is up. Audio written to the
// talk channel during a ring is not heard until the ring is over, which makes talking useless
// at exactly the moment somebody is standing at the gate. Ending the call first frees the
// speaker — and stops every screen in the house ringing, which is what answering means anyway.

import { request } from 'node:http'
import { createHash } from 'node:crypto'

const md5 = (text) => createHash('md5').update(text).digest('hex').toUpperCase()

export class Rpc {
  #host
  #port
  #username
  #password
  #session = ''
  #id = 0

  constructor({ host, port, username, password }) {
    this.#host = host
    this.#port = port
    this.#username = username
    this.#password = password
  }

  /**
   * Two rounds, as the protocol wants: ask, be given a realm and a one-time number, answer with
   * a hash of both. The password never crosses the wire.
   */
  async login() {
    const challenge = await this.call(
      'global.login',
      { userName: this.#username, password: '', clientType: 'Web3.0', loginType: 'Direct' },
      undefined,
      '/RPC2_Login'
    )

    this.#session = challenge.session ?? ''

    const first = md5(`${this.#username}:${challenge.params.realm}:${this.#password}`)
    const answer = await this.call(
      'global.login',
      {
        userName: this.#username,
        password: md5(`${this.#username}:${challenge.params.random}:${first}`),
        clientType: 'Web3.0',
        loginType: 'Direct',
        authorityType: 'Default',
      },
      undefined,
      '/RPC2_Login'
    )

    if (!answer.result) throw new Error('the intercom refused the account')
    this.#session = answer.session ?? this.#session
    return this
  }

  call(method, params = null, object = undefined, path = '/RPC2') {
    this.#id += 1

    const body = JSON.stringify({
      method,
      params,
      object,
      id: this.#id,
      session: this.#session || undefined,
    })

    return new Promise((resolve, reject) => {
      const outbound = request(
        {
          host: this.#host,
          port: this.#port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            // Node's own `fetch` dies on some of these replies with Z_DATA_ERROR. Asking for
            // no compression at all is cheaper than working out whose fault that is.
            'Accept-Encoding': 'identity',
          },
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { text += chunk })
          response.on('end', () => {
            try {
              resolve(JSON.parse(text))
            } catch {
              reject(new Error(`unreadable reply: ${text.slice(0, 120)}`))
            }
          })
        }
      )

      outbound.on('error', reject)
      outbound.setTimeout(5_000, () => outbound.destroy(new Error('timed out')))
      outbound.end(body)
    })
  }
}
