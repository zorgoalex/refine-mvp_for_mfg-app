import { dataProvider as postgrestDataProvider, createClient } from "@ffimnsr/refine-postgrest";

const API_TOKEN = import.meta.env.VITE_API_TOKEN as string;

export const dataProvider = (apiUrl: string) => {
  const client = createClient(apiUrl, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
    },
  });

  return postgrestDataProvider(client);
};
