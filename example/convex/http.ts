import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { components } from "./_generated/api";

const http = httpRouter();

registerStaticRoutes(http, components.selfHosting, { spaFallback: true });

export default http;
