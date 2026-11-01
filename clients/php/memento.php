<?php
// memento.php — a complete JSMemento client in PHP (8.1+, the curl and json extensions).
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
// Run:
//   MEMENTO_API_KEY=mk_… php memento.php

const DEFAULT_URL = 'https://service.stage.memento-service.org/memento';

final class ApiError extends RuntimeException {}

$baseUrl = rtrim(getenv('MEMENTO_URL') ?: DEFAULT_URL, '/');
$apiKey = getenv('MEMENTO_API_KEY') ?: '';

/** POST a JSON body to the API and return the envelope's `data`; throws ApiError. */
function post(string $path, array $body): array
{
    global $baseUrl, $apiKey;
    $curl = curl_init($baseUrl . $path);
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($body),
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $apiKey", 'Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    $raw = curl_exec($curl);
    if ($raw === false) {
        throw new ApiError("Cannot reach $baseUrl: " . curl_error($curl));
    }
    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $envelope = json_decode($raw, true);
    if ($status >= 300) {
        $message = $envelope['error']['message'] ?? 'request failed';
        throw new ApiError("HTTP $status: $message");
    }
    return $envelope['data'];
}

/** 1. Push one event; returns the stored event. */
function push(string $user): array
{
    $event = post('/events', [
        'event_type' => 'USER_LOGIN',
        'instance_type' => 'user',
        'instance_id' => $user,
        'actor_id' => $user,
        'payload' => ['ip' => '127.0.0.1', 'client' => 'php'],
    ]);
    echo "Pushed {$event['id']}\n";
    echo "  {$event['rendered']}\n";
    return $event;
}

/** 2. The last 10 events of user/<user>, newest first. */
function query(string $user): void
{
    $events = post('/events/query', [
        'filter' => ['and' => [
            ['field' => 'instance_type', 'op' => 'eq', 'value' => 'user'],
            ['field' => 'instance_id', 'op' => 'eq', 'value' => $user],
        ]],
        'limit' => 10,
    ]);
    echo "\nLatest events of user/$user:\n";
    foreach ($events as $event) {
        echo "  {$event['occurred_at']}  {$event['event_type']}  " . ($event['rendered'] ?? '') . "\n";
    }
}

/** 3. Not in this sample: PHP has no WebSocket client without a library. */
function tail(string $user): void
{
    echo "\nTail: not in this sample (the JavaScript, TypeScript, Python, Go, Java and Rust ones have it).\n";
}

/** The OS user name: the instance and actor of the event. */
function osUser(): string
{
    if (function_exists('posix_getpwuid')) {
        $entry = posix_getpwuid(posix_geteuid());
        if ($entry !== false && $entry['name'] !== '') {
            return $entry['name'];
        }
    }
    return getenv('USER') ?: getenv('USERNAME') ?: 'anonymous';
}

if ($apiKey === '') {
    fwrite(STDERR, "Set MEMENTO_API_KEY (create one at https://service.stage.memento-service.org/keys)\n");
    exit(2);
}
$user = osUser();
try {
    push($user);
    query($user);
    tail($user);
} catch (ApiError $error) {
    fwrite(STDERR, $error->getMessage() . "\n");
    exit(1);
}
