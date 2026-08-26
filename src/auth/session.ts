import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "./guard.js";

export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; 

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",

    secure: request.protocol === "https",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}
