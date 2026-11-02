import { MementoStream } from "@memento/core";

// What happens to user/42 from now on, rendered in Serbian. The key needs the read scope.
const stream = new MementoStream({
  baseUrl: "http://localhost:8000/memento",
  apiKey: process.env.MEMENTO_API_KEY ?? "",
  filter: { instance_type: "user", instance_id: "42" },
  locale: "sr",
  onStatus: (status) => console.log(`[${status}]`),
  onEvent: (event) => console.log(event.occurred_at, event.rendered),
});

// It reconnects by itself (0.5 s doubling to 15 s) until you close it.
process.on("SIGINT", () => stream.close());
