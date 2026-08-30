# Developing guide

## Running locally

```sh
npm i
npm run dev
```

## Testing

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run test
```

Add a Changeset for user-visible package changes:

```sh
npm run changeset
```

Do not remove `private: true` or publish an npm package without an explicit release decision.
