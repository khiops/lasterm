/**
 * Test-only: how a spec builds a hub server, without the hub lock.
 *
 * Outside the tests, a listening hub is reached through `startHub` alone, which
 * takes the lock before it constructs anything. `createServer` and
 * `startServer` stay exported from `server.ts` only because a module cannot
 * share a function with exactly one other; the lint configuration refuses them
 * to every importer but `hub-startup.ts` and this file, and refuses this file
 * to everything that is not a test. A new module therefore cannot serve beside
 * the lock by importing the primitives: it gets a lint error that names the way
 * in.
 *
 * Specs come through here because what they test is the server itself, built
 * from databases, TLS material and options they choose. The lock guards a state
 * directory they do not use, and each of their servers is private to its spec,
 * on a port the system assigns or never listening at all.
 */
export { createServer, startServer } from "./server.js";
