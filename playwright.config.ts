// Default e2e profile: everything local, IdP = mock-oauth2-server (env/local.env).
import { makeConfig } from "./e2e/config-factory";

export default makeConfig("local");
