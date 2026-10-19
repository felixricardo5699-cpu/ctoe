/*
 * The doorbell: how a browser wakes this app when it is not running.
 *
 * Everything an extension has to say goes over the loopback bridge, where a token is checked.
 * This is the one thing that does not. A `ctoe://` URL is handed to the OS by whatever was clicked,
 * and a command line is something any program - or a link on any page - can produce. So the scheme
 * carries nothing: no sentence, no token, no language. It says "wake up" and that is all.
 *
 * That is why the only thing read out of an argument here is whether it is a doorbell at all, and
 * why the answer is a boolean rather than a parsed link: there is no field for anything to arrive
 * in. The file touches no Electron either, so the rule can be tested instead of trusted.
 */

/** The scheme the OS is asked to route back to this app. Registered in electron-builder.yml. */
export const DOORBELL_SCHEME = 'ctoe'

/**
 * Whether this command line carries a doorbell.
 *
 * Loose about everything after the scheme on purpose. The installer, the shell and Windows itself
 * have all been seen to hand the URL over with or without a trailing slash, and since nothing past
 * the scheme is ever read, being strict would only invent ways for a real doorbell to be missed -
 * while a strictness that rejects a perfectly good ring buys nothing at all.
 */
export function doorbellRequested(argv: readonly string[]): boolean {
  return argv.some((argument) => /^ctoe:/i.test(argument.trim()))
}
