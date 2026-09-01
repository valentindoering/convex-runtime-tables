import { exposeDeploymentQuery } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

// Upload mutations remain internal to the component and require deployment
// credentials through its CLI. This public query only supports deploy updates.
export const { getCurrentDeployment } = exposeDeploymentQuery(
  components.selfHosting,
);
