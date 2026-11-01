// main.go — a complete JSMemento client in Go (net/http, encoding/json, coder/websocket).
//
// It does three things, in this order:
//  1. push    one USER_LOGIN event for you (the OS user) and print its id and rendered line;
//  2. query   the last 10 events of user/<you>;
//  3. tail    the live stream of user/<you> for 10 seconds.
//
// Environment:
//
//	MEMENTO_API_KEY  your API key with the read and write scopes (required)
//	MEMENTO_URL      the API base, default https://service.stage.memento-service.org/memento
//
// Run:
//
//	MEMENTO_API_KEY=mk_… go run .
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	defaultURL  = "https://service.stage.memento-service.org/memento"
	tailSeconds = 10
)

var (
	baseURL = strings.TrimRight(envOr("MEMENTO_URL", defaultURL), "/")
	apiKey  = os.Getenv("MEMENTO_API_KEY")
	client  = &http.Client{Timeout: 30 * time.Second}
)

// Event is an event as the API returns it (the fields this program prints).
type Event struct {
	ID         string  `json:"id"`
	OccurredAt string  `json:"occurred_at"`
	EventType  string  `json:"event_type"`
	Rendered   *string `json:"rendered"`
}

// text is the rendered line, or the event type when the event has none.
func (e Event) text() string {
	if e.Rendered != nil {
		return *e.Rendered
	}
	return e.EventType
}

type envelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// post sends a JSON body to the API and decodes the envelope's data into out.
func post(path string, body any, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("Cannot reach %s: %w", baseURL, err)
	}
	defer response.Body.Close()
	var env envelope
	decodeErr := json.NewDecoder(response.Body).Decode(&env)
	if response.StatusCode >= 300 {
		message := http.StatusText(response.StatusCode)
		if decodeErr == nil && env.Error != nil {
			message = env.Error.Message
		}
		return fmt.Errorf("HTTP %d: %s", response.StatusCode, message)
	}
	if decodeErr != nil {
		return fmt.Errorf("invalid response: %w", decodeErr)
	}
	return json.Unmarshal(env.Data, out)
}

// push stores one event and prints its id and rendered line.
func push(who string) error {
	var event Event
	err := post("/events", map[string]any{
		"event_type":    "USER_LOGIN",
		"instance_type": "user",
		"instance_id":   who,
		"actor_id":      who,
		"payload":       map[string]any{"ip": "127.0.0.1", "client": "golang"},
	}, &event)
	if err != nil {
		return err
	}
	fmt.Printf("Pushed %s\n  %s\n", event.ID, event.text())
	return nil
}

// query prints the last 10 events of user/<who>, newest first.
func query(who string) error {
	var events []Event
	err := post("/events/query", map[string]any{
		"filter": map[string]any{"and": []map[string]any{
			{"field": "instance_type", "op": "eq", "value": "user"},
			{"field": "instance_id", "op": "eq", "value": who},
		}},
		"limit": 10,
	}, &events)
	if err != nil {
		return err
	}
	fmt.Printf("\nLatest events of user/%s:\n", who)
	for _, event := range events {
		fmt.Printf("  %s  %s  %s\n", event.OccurredAt, event.EventType, event.text())
	}
	return nil
}

// tail prints every new event of user/<who> for tailSeconds seconds.
func tail(who string) error {
	ctx, cancel := context.WithTimeout(context.Background(), tailSeconds*time.Second)
	defer cancel()
	params := url.Values{"instance_type": {"user"}, "instance_id": {who}, "locale": {"en"}}
	wsURL := "ws" + strings.TrimPrefix(baseURL, "http") + "/ws?" + params.Encode()
	// The key travels as a subprotocol; the server answers with `memento.v1`.
	conn, response, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{"memento.v1", "bearer." + apiKey},
	})
	if err != nil {
		if response != nil {
			return fmt.Errorf("Tail: HTTP %d from the stream", response.StatusCode)
		}
		return fmt.Errorf("Tail: cannot open the stream: %w", err)
	}
	defer conn.CloseNow()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				conn.Close(websocket.StatusNormalClosure, "")
				fmt.Println("Done.")
				return nil
			}
			return fmt.Errorf("Tail: the stream failed: %w", err)
		}
		var frame struct {
			Kind    string `json:"kind"`
			Payload Event  `json:"payload"`
		}
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		switch frame.Kind {
		case "memento.welcome":
			fmt.Printf("\nTailing user/%s for %d s …\n", who, tailSeconds)
		case "memento.event.new":
			fmt.Printf("  %s\n", frame.Payload.text())
		} // anything else (memento.pong, …) is ignored
	}
}

// osUser is the OS user name: the instance and actor of the event.
func osUser() string {
	if current, err := user.Current(); err == nil && current.Username != "" {
		name := current.Username
		if i := strings.LastIndex(name, `\`); i >= 0 { // DOMAIN\name on Windows
			name = name[i+1:]
		}
		return name
	}
	return envOr("USER", envOr("USERNAME", "anonymous"))
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "Set MEMENTO_API_KEY (create one at https://service.stage.memento-service.org/keys)")
		os.Exit(2)
	}
	who := osUser()
	for _, step := range []func(string) error{push, query, tail} {
		if err := step(who); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
