import { httpRouter } from "convex/server";

import { auth } from "./auth";
import { hostedAutorespond } from "./autorespond";
import { HOSTED_AUTORESPOND_PATH } from "../src/domain/hosted-autorespond";

const http = httpRouter();
auth.addHttpRoutes(http);
http.route({ handler: hostedAutorespond, method: "POST", path: HOSTED_AUTORESPOND_PATH });

export default http;
