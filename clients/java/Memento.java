// Memento.java — a complete JSMemento client in Java 21 (java.net.http, no dependencies).
//
// It does three things, in this order:
//   1. push    one USER_LOGIN event for you (the OS user) and print its id and rendered line;
//   2. query   the last 10 events of user/<you>;
//   3. tail    the live stream of user/<you> for 10 seconds.
//
// Environment:
//   MEMENTO_API_KEY  your API key with the read and write scopes (required)
//   MEMENTO_URL      the API base, default https://service.memento-service.org/memento
//
// Run (single-file source launch, nothing to compile first):
//   MEMENTO_API_KEY=mk_… java Memento.java

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public class Memento {
    static final String DEFAULT_URL = "https://service.memento-service.org/memento";
    static final int TAIL_SECONDS = 10;

    static final String BASE_URL = env("MEMENTO_URL", DEFAULT_URL).replaceAll("/+$", "");
    static final String API_KEY = env("MEMENTO_API_KEY", "");
    // HTTP/1.1: on plain http:// the default would try an h2c upgrade, which Node servers refuse.
    static final HttpClient HTTP = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(30))
            .build();

    static class ApiError extends RuntimeException {
        ApiError(String message) { super(message); }
    }

    public static void main(String[] args) {
        if (API_KEY.isEmpty()) {
            System.err.println("Set MEMENTO_API_KEY (create one at https://service.memento-service.org/keys)");
            System.exit(2);
        }
        String user = osUser();
        try {
            push(user);
            query(user);
            tail(user);
        } catch (ApiError error) {
            System.err.println(error.getMessage());
            System.exit(1);
        }
    }

    /** 1. Push one event; returns the stored event. */
    static Map<String, Object> push(String user) {
        String body = "{\"event_type\":\"USER_LOGIN\",\"instance_type\":\"user\","
                + "\"instance_id\":" + Json.quote(user) + ",\"actor_id\":" + Json.quote(user) + ","
                + "\"payload\":{\"ip\":\"127.0.0.1\",\"client\":\"java\"}}";
        Map<String, Object> event = Json.object(post("/events", body));
        System.out.println("Pushed " + event.get("id"));
        System.out.println("  " + text(event));
        return event;
    }

    /** 2. The last 10 events of user/<user>, newest first. */
    static void query(String user) {
        String body = "{\"filter\":{\"and\":["
                + "{\"field\":\"instance_type\",\"op\":\"eq\",\"value\":\"user\"},"
                + "{\"field\":\"instance_id\",\"op\":\"eq\",\"value\":" + Json.quote(user) + "}"
                + "]},\"limit\":10}";
        List<?> events = (List<?>) post("/events/query", body);
        System.out.println("\nLatest events of user/" + user + ":");
        for (Object item : events) {
            Map<String, Object> event = Json.object(item);
            System.out.println("  " + event.get("occurred_at") + "  " + event.get("event_type") + "  " + text(event));
        }
    }

    /** 3. Print every new event of user/<user> for TAIL_SECONDS seconds. */
    static void tail(String user) {
        String query = "instance_type=user&instance_id=" + URLEncoder.encode(user, StandardCharsets.UTF_8) + "&locale=en";
        URI uri = URI.create(BASE_URL.replaceFirst("^http", "ws") + "/ws?" + query);
        CompletableFuture<String> closed = new CompletableFuture<>(); // why the server ended it
        WebSocket.Listener listener = new WebSocket.Listener() {
            final StringBuilder frame = new StringBuilder();

            @Override
            public CompletionStage<?> onClose(WebSocket socket, int code, String reason) {
                closed.complete(code + " " + reason);
                return null;
            }

            @Override
            public void onError(WebSocket socket, Throwable error) {
                closed.complete(String.valueOf(error));
            }

            @Override
            public CompletionStage<?> onText(WebSocket socket, CharSequence data, boolean last) {
                frame.append(data); // a frame may arrive in parts
                if (last) {
                    Map<String, Object> message = Json.object(Json.parse(frame.toString()));
                    frame.setLength(0);
                    Object kind = message.get("kind");
                    if ("memento.welcome".equals(kind)) {
                        System.out.println("\nTailing user/" + user + " for " + TAIL_SECONDS + " s …");
                    } else if ("memento.event.new".equals(kind)) {
                        System.out.println("  " + text(Json.object(message.get("payload"))));
                    } // anything else (memento.pong, …) is ignored
                }
                socket.request(1);
                return null;
            }
        };
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TAIL_SECONDS);
        WebSocket socket;
        try {
            // The key travels as a subprotocol; the server answers with `memento.v1`.
            socket = HTTP.newWebSocketBuilder()
                    .subprotocols("memento.v1", "bearer." + API_KEY)
                    .connectTimeout(Duration.ofSeconds(TAIL_SECONDS))
                    .buildAsync(uri, listener)
                    .join();
        } catch (CompletionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof java.net.http.WebSocketHandshakeException handshake) {
                throw new ApiError("Tail: HTTP " + handshake.getResponse().statusCode() + " from the stream");
            }
            throw new ApiError("Tail: cannot open the stream: " + cause);
        }
        try {
            String reason = closed.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            throw new ApiError("Tail: the server closed the stream (" + reason + ")");
        } catch (TimeoutException expected) {
            // the 10 seconds are over
        } catch (InterruptedException | ExecutionException error) {
            Thread.currentThread().interrupt();
        }
        socket.sendClose(WebSocket.NORMAL_CLOSURE, "").orTimeout(2, TimeUnit.SECONDS).exceptionally(e -> null).join();
        socket.abort();
        System.out.println("Done.");
    }

    /** POST a JSON body to the API and return the envelope's `data`; throws ApiError. */
    static Object post(String path, String body) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(BASE_URL + path))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + API_KEY)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> response;
        try {
            response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception error) {
            throw new ApiError("Cannot reach " + BASE_URL + ": " + error);
        }
        Map<String, Object> envelope;
        try {
            envelope = Json.object(Json.parse(response.body()));
        } catch (RuntimeException error) {
            envelope = Map.of();
        }
        if (response.statusCode() >= 300) {
            Object message = envelope.get("error") instanceof Map<?, ?> e ? e.get("message") : "request failed";
            throw new ApiError("HTTP " + response.statusCode() + ": " + message);
        }
        return envelope.get("data");
    }

    /** The rendered line, or the event type when the event has none. */
    static String text(Map<String, Object> event) {
        Object rendered = event.get("rendered");
        return rendered != null ? rendered.toString() : String.valueOf(event.get("event_type"));
    }

    /** The OS user name: the instance and actor of the event. */
    static String osUser() {
        String name = System.getProperty("user.name");
        return name == null || name.isBlank() ? "anonymous" : name;
    }

    static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isEmpty() ? fallback : value;
    }

    /** Just enough JSON: quote a string, and parse a document into Map / List / String / Double / Boolean / null. */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) { this.s = s; }

        static String quote(String value) {
            StringBuilder out = new StringBuilder("\"");
            for (char c : value.toCharArray()) {
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n");
                    case '\r' -> out.append("\\r");
                    case '\t' -> out.append("\\t");
                    default -> {
                        if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                        else out.append(c);
                    }
                }
            }
            return out.append('"').toString();
        }

        static Object parse(String text) {
            Json parser = new Json(text);
            Object value = parser.value();
            parser.space();
            if (parser.i != text.length()) throw parser.error();
            return value;
        }

        @SuppressWarnings("unchecked")
        static Map<String, Object> object(Object value) {
            return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
        }

        private Object value() {
            space();
            if (i >= s.length()) throw error();
            char c = s.charAt(i);
            if (c == '{') return objectValue();
            if (c == '[') return arrayValue();
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            if (start == i) throw error();
            return Double.parseDouble(s.substring(start, i));
        }

        private Map<String, Object> objectValue() {
            Map<String, Object> map = new LinkedHashMap<>();
            i++;
            space();
            if (peek('}')) return map;
            do {
                space();
                String key = string();
                space();
                expect(':');
                map.put(key, value());
                space();
            } while (peek(','));
            expect('}');
            return map;
        }

        private List<Object> arrayValue() {
            List<Object> list = new ArrayList<>();
            i++;
            space();
            if (peek(']')) return list;
            do {
                list.add(value());
                space();
            } while (peek(','));
            expect(']');
            return list;
        }

        private String string() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return out.toString();
                if (c != '\\') { out.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'u' -> { out.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    default -> out.append(e); // \" \\ \/
                }
            }
            throw error();
        }

        private void space() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private boolean peek(char c) {
            if (i < s.length() && s.charAt(i) == c) { i++; return true; }
            return false;
        }

        private void expect(char c) {
            if (!peek(c)) throw error();
        }

        private IllegalArgumentException error() {
            return new IllegalArgumentException("invalid JSON at offset " + i);
        }
    }
}
