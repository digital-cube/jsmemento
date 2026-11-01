// memento.cpp — a complete JSMemento client in C++17 (libcurl, no other dependency).
//
// It does three things, in this order:
//   1. push    one USER_LOGIN event for you (the OS user) and print its id and rendered line;
//   2. query   the last 10 events of user/<you>;
//   3. tail    is not in this sample (the JavaScript, TypeScript, Python, Go, Java and Rust ones have it).
//
// Environment:
//   MEMENTO_API_KEY  your API key with the read and write scopes (required)
//   MEMENTO_URL      the API base, default https://service.stage.memento-service.org/memento
//
// Build and run:
//   cmake -B build && cmake --build build
//   MEMENTO_API_KEY=mk_… ./build/memento

#include <curl/curl.h>

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <lmcons.h>
#include <windows.h>
#else
#include <pwd.h>
#include <unistd.h>
#endif

namespace {

const char* DEFAULT_URL = "https://service.stage.memento-service.org/memento";

struct ApiError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// ---- Just enough JSON: quote a string, parse a document --------------------------------

std::string quote(const std::string& value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char escaped[8];
                    std::snprintf(escaped, sizeof escaped, "\\u%04x", c);
                    out += escaped;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out + "\"";
}

struct Json {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    bool boolean = false;
    double number = 0;
    std::string string;
    std::vector<Json> array;
    std::map<std::string, Json> object;

    // obj["key"]: the member, or null when this is not an object or has no such key.
    const Json& operator[](const std::string& key) const {
        static const Json null;
        auto it = object.find(key);
        return type == Object && it != object.end() ? it->second : null;
    }
    std::string str() const { return type == String ? string : ""; }
};

class Parser {
   public:
    explicit Parser(const std::string& text) : s_(text) {}

    Json parse() {
        Json value = parseValue();
        space();
        if (i_ != s_.size()) fail();
        return value;
    }

   private:
    const std::string& s_;
    size_t i_ = 0;

    [[noreturn]] void fail() const { throw std::runtime_error("invalid JSON at offset " + std::to_string(i_)); }
    void space() {
        while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\n' || s_[i_] == '\r' || s_[i_] == '\t')) i_++;
    }
    bool peek(char c) {
        if (i_ < s_.size() && s_[i_] == c) {
            i_++;
            return true;
        }
        return false;
    }
    void expect(char c) {
        if (!peek(c)) fail();
    }
    bool literal(const char* word) {
        std::string w(word);
        if (s_.compare(i_, w.size(), w) != 0) return false;
        i_ += w.size();
        return true;
    }

    Json parseValue() {
        space();
        if (i_ >= s_.size()) fail();
        Json value;
        char c = s_[i_];
        if (c == '{') {
            value.type = Json::Object;
            i_++;
            space();
            if (peek('}')) return value;
            do {
                space();
                std::string key = parseString();
                space();
                expect(':');
                value.object[key] = parseValue();
                space();
            } while (peek(','));
            expect('}');
        } else if (c == '[') {
            value.type = Json::Array;
            i_++;
            space();
            if (peek(']')) return value;
            do {
                value.array.push_back(parseValue());
                space();
            } while (peek(','));
            expect(']');
        } else if (c == '"') {
            value.type = Json::String;
            value.string = parseString();
        } else if (literal("true")) {
            value.type = Json::Bool;
            value.boolean = true;
        } else if (literal("false")) {
            value.type = Json::Bool;
        } else if (literal("null")) {
            value.type = Json::Null;
        } else {
            size_t start = i_;
            while (i_ < s_.size() && std::string("+-0123456789.eE").find(s_[i_]) != std::string::npos) i_++;
            if (start == i_) fail();
            value.type = Json::Number;
            value.number = std::strtod(s_.substr(start, i_ - start).c_str(), nullptr);
        }
        return value;
    }

    unsigned hex4() {
        if (i_ + 4 > s_.size()) fail();
        unsigned code = std::stoul(s_.substr(i_, 4), nullptr, 16);
        i_ += 4;
        return code;
    }

    static void utf8(std::string& out, unsigned code) {
        if (code < 0x80) {
            out += static_cast<char>(code);
        } else if (code < 0x800) {
            out += static_cast<char>(0xC0 | (code >> 6));
            out += static_cast<char>(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
            out += static_cast<char>(0xE0 | (code >> 12));
            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (code & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (code >> 18));
            out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (code & 0x3F));
        }
    }

    std::string parseString() {
        expect('"');
        std::string out;
        while (i_ < s_.size()) {
            char c = s_[i_++];
            if (c == '"') return out;
            if (c != '\\') {
                out += c;
                continue;
            }
            if (i_ >= s_.size()) fail();
            char e = s_[i_++];
            switch (e) {
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'u': {
                    unsigned code = hex4();
                    if (code >= 0xD800 && code < 0xDC00 && literal("\\u")) {  // surrogate pair
                        code = 0x10000 + ((code - 0xD800) << 10) + (hex4() - 0xDC00);
                    }
                    utf8(out, code);
                    break;
                }
                default: out += e;  // \" \\ \/
            }
        }
        fail();
    }
};

// ---- HTTP -----------------------------------------------------------------------------

std::string g_base_url;
std::string g_api_key;

size_t collect(char* data, size_t size, size_t count, void* target) {
    static_cast<std::string*>(target)->append(data, size * count);
    return size * count;
}

// POST a JSON body to the API and return the envelope's `data`; throws ApiError.
Json post(const std::string& path, const std::string& body) {
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
    if (!curl) throw ApiError("cannot initialise libcurl");
    std::string url = g_base_url + path;
    std::string auth = "Authorization: Bearer " + g_api_key;
    curl_slist* headers = curl_slist_append(nullptr, auth.c_str());
    headers = curl_slist_append(headers, "Content-Type: application/json");
    std::string response;
    curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl.get(), CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, collect);
    curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 30L);
    CURLcode result = curl_easy_perform(curl.get());
    curl_slist_free_all(headers);
    if (result != CURLE_OK) {
        throw ApiError("Cannot reach " + g_base_url + ": " + curl_easy_strerror(result));
    }
    long status = 0;
    curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status);
    Json envelope;
    try {
        envelope = Parser(response).parse();
    } catch (const std::runtime_error&) {
        // not JSON: the status line below says enough
    }
    if (status >= 300) {
        std::string message = envelope["error"]["message"].str();
        throw ApiError("HTTP " + std::to_string(status) + ": " + (message.empty() ? "request failed" : message));
    }
    return envelope["data"];
}

// The rendered line, or the event type when the event has none.
std::string text(const Json& event) {
    return event["rendered"].type == Json::String ? event["rendered"].str() : event["event_type"].str();
}

// ---- The three steps ------------------------------------------------------------------

// 1. Push one event; returns the stored event.
Json push(const std::string& user) {
    Json event = post("/events",
                      "{\"event_type\":\"USER_LOGIN\",\"instance_type\":\"user\",\"instance_id\":" + quote(user) +
                          ",\"actor_id\":" + quote(user) +
                          ",\"payload\":{\"ip\":\"127.0.0.1\",\"client\":\"cpp\"}}");
    std::cout << "Pushed " << event["id"].str() << "\n  " << text(event) << "\n";
    return event;
}

// 2. The last 10 events of user/<user>, newest first.
void query(const std::string& user) {
    Json events = post("/events/query",
                       "{\"filter\":{\"and\":["
                       "{\"field\":\"instance_type\",\"op\":\"eq\",\"value\":\"user\"},"
                       "{\"field\":\"instance_id\",\"op\":\"eq\",\"value\":" +
                           quote(user) + "}]},\"limit\":10}");
    std::cout << "\nLatest events of user/" << user << ":\n";
    for (const Json& event : events.array) {
        std::cout << "  " << event["occurred_at"].str() << "  " << event["event_type"].str() << "  " << text(event)
                  << "\n";
    }
}

// 3. Not in this sample: libcurl has no WebSocket client on every platform yet.
void tail(const std::string&) {
    std::cout << "\nTail: not in this sample (the JavaScript, TypeScript, Python, Go, Java and Rust ones have it).\n";
}

// The OS user name: the instance and actor of the event.
std::string osUser() {
#ifdef _WIN32
    char name[UNLEN + 1];
    DWORD size = sizeof name;
    if (GetUserNameA(name, &size)) return name;
#else
    if (const passwd* entry = getpwuid(geteuid()); entry && entry->pw_name && *entry->pw_name) return entry->pw_name;
#endif
    for (const char* variable : {"USER", "USERNAME"}) {
        if (const char* value = std::getenv(variable); value && *value) return value;
    }
    return "anonymous";
}

std::string env(const char* name, const std::string& fallback) {
    const char* value = std::getenv(name);
    return value && *value ? value : fallback;
}

}  // namespace

int main() {
    g_api_key = env("MEMENTO_API_KEY", "");
    if (g_api_key.empty()) {
        std::cerr << "Set MEMENTO_API_KEY (create one at https://service.stage.memento-service.org/keys)\n";
        return 2;
    }
    g_base_url = env("MEMENTO_URL", DEFAULT_URL);
    while (!g_base_url.empty() && g_base_url.back() == '/') g_base_url.pop_back();

    curl_global_init(CURL_GLOBAL_DEFAULT);
    int code = 0;
    try {
        std::string user = osUser();
        push(user);
        query(user);
        tail(user);
    } catch (const ApiError& error) {
        std::cout.flush();
        std::cerr << error.what() << "\n";
        code = 1;
    }
    curl_global_cleanup();
    return code;
}
