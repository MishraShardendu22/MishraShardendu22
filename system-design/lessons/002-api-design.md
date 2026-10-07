# DAY 2: API Design

## 1. Why this concept exists

A distributed system is a collection of components that communicate through contracts. API design is the discipline of making those contracts explicit, stable, evolvable, and operationally useful.

A poorly designed API creates architectural problems that cannot be fixed cleanly inside the implementation. Ambiguous resource semantics produce inconsistent state transitions. Unbounded list endpoints create memory and latency spikes. Weak error contracts force clients to parse strings. Non-idempotent write semantics make retries dangerous. Breaking schema changes turn routine deployments into coordinated migrations across services.

The engineering objective is not merely to expose HTTP endpoints. It is to define a contract that remains usable while traffic, clients, implementations, and failure modes change.

## 2. Core idea

Treat an API as a compatibility boundary.

A useful contract specifies:

- Resource identity and lifecycle.
- Operations and their side effects.
- Input validation and invariants.
- Response shape and semantics.
- Error taxonomy.
- Pagination semantics for collections.
- Authentication and authorization expectations.
- Idempotency behavior for retryable writes.
- Versioning and backward-compatibility rules.
- Limits such as payload size, page size, and request rate.

For HTTP APIs, method semantics matter. GET should retrieve state without a server-side business side effect. POST commonly creates a subordinate resource or triggers a non-idempotent operation. PUT is appropriate when the client supplies the complete representation at a known identity. PATCH expresses partial modification.

An API is successful when clients can reason about behavior without knowing how the server is implemented.

### Contract example

For a task service:

`POST /v1/tasks`

Request:
```json
{
  "name": "rebuild-index",
  "priority": 50
}
```

Response:
```json
{
  "id": "tsk_01J...",
  "name": "rebuild-index",
  "priority": 50,
  "status": "queued",
  "created_at": "2026-10-08T00:00:00Z"
}
```

The contract should also define what happens for invalid priority, duplicate creation attempts, authorization failures, timeouts, and malformed JSON.

### Pagination

Never design a collection API as if the collection is small.

For high-volume or frequently changing data, cursor pagination is generally preferable to offset pagination because it avoids scanning and instability caused by inserts/deletes ahead of the current offset.

Example:

`GET /v1/tasks?limit=100&cursor=eyJpZCI6...`

Response:

```json
{
  "items": [],
  "next_cursor": "eyJpZCI6..."
}
```

The cursor should be opaque to the client. Its internal representation can change without changing the public contract.

### Idempotency

Retries are inevitable in distributed systems because clients cannot always distinguish a lost response from a failed operation.

For operations such as payment creation or job submission, use an idempotency key when repeating the request must not create another logical operation.

The invariant is:

`same logical operation + same idempotency key -> same result`

The storage and scope of the idempotency record become part of the system design. This topic will later connect directly to retries and distributed workflows.

### Versioning

Version only when the contract needs incompatible evolution. Prefer additive changes when possible.

Safe examples include adding optional response fields or optional request fields with sensible defaults. Removing fields, changing types, or changing the meaning of an existing field is generally a breaking change.

Versioning is a compatibility policy, not just a URL convention.

## 3. Mental model

Think of an API as a protocol between independently deployed state machines.

The client knows:

`input -> contract -> expected outcome`

The server owns the implementation, storage, scaling, and internal topology.

The API boundary should therefore expose stable semantics and hide implementation details.

A strong test is:

> Can a client safely retry, paginate, validate errors, and upgrade independently without knowing the server's internal architecture?

If not, the contract is probably leaking implementation details or leaving important behavior undefined.

## 4. Real-world example

GitHub publicly documents its REST API as a versioned HTTP API with explicit methods, paths, headers, parameters, pagination, and rate-limit behavior. GitHub also documents using pagination links rather than assuming a fixed page model, and recommends conditional requests and careful handling of rate-limit responses. citeturn0search2turn0search3turn0search0

This is a public, documented example. The lesson is not that GitHub's internal service topology is known from these API documents. The useful observation is that a large production API has to make resource semantics, pagination, compatibility, and operational limits explicit.

Industry-standard inference: any API serving large collections should bound response size and define pagination rather than returning an unbounded result set.

## 5. LLD

At object level, separate transport concerns from domain behavior.

A reasonable boundary is:

```
HTTP Handler
    |
    v
Request DTO -> Validator
    |
    v
Task Service
    |
    +----> Task Repository
    |
    +----> Event Publisher
```

The handler should translate HTTP into an application command and translate the result back into an HTTP response. It should not contain business rules or database logic.

Relevant interfaces:

```go
type TaskRepository interface {
    Create(ctx context.Context, task *Task) error
    Get(ctx context.Context, id string) (*Task, error)
}

type TaskService interface {
    Create(ctx context.Context, cmd CreateTaskCommand) (*Task, error)
}
```

The abstraction is useful because the application service can be tested without an HTTP server or concrete database.

Do not introduce interfaces merely because interfaces exist. A one-method interface with no substitution boundary often adds indirection without reducing coupling.

## 6. HLD

At system level, the API becomes the contract between clients and a horizontally scalable service tier.

```
Clients
   |
   v
Load Balancer / Reverse Proxy
   |
   +-------------------+
   |                   |
   v                   v
API Instance 1     API Instance N
   |                   |
   +---------+---------+
             |
             v
       Application Service
          |         |
          v         v
        Cache      Database
          |
          v
      Queue / Event Bus
```

The request path should remain bounded.

For a synchronous create operation:

`Client -> LB -> API -> validation -> database transaction -> response`

If secondary work is not required to complete before acknowledging the request:

`Client -> API -> durable write -> enqueue event -> response`

The API contract must make the distinction visible. A response such as `202 Accepted` communicates that the operation was accepted for asynchronous processing, whereas `201 Created` normally indicates that the resource has been created.

Scaling is mostly horizontal because API instances should be stateless. Authentication/session state, if required, should live in shared infrastructure rather than process-local memory unless locality is deliberate.

Failure modes include:

- Database timeout after the request was accepted.
- Client timeout after the server committed the operation.
- Duplicate requests caused by retries.
- Overly large collection responses.
- Slow downstream dependencies.
- Schema incompatibility between independently deployed clients and servers.
- Load spikes causing queueing and tail-latency growth.

API design cannot eliminate these failures. It must make their semantics explicit so the surrounding architecture can handle them.

## 7. Code

The following Go example implements a small production-oriented HTTP boundary. It demonstrates typed request/response models, validation, explicit errors, bounded pagination, concurrency-safe storage, and separation between HTTP and application logic.

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Task struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Priority  int       `json:"priority"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

type CreateTaskRequest struct {
	Name     string `json:"name"`
	Priority int    `json:"priority"`
}

type TaskRepository interface {
	Create(context.Context, *Task) error
	Get(context.Context, string) (*Task, error)
	List(context.Context, int, string) ([]Task, string, error)
}

var (
	ErrNotFound = errors.New("task not found")
	ErrConflict = errors.New("task already exists")
)

type MemoryTaskRepository struct {
	mu    sync.RWMutex
	tasks map[string]Task
}

func NewMemoryTaskRepository() *MemoryTaskRepository {
	return &MemoryTaskRepository{
		tasks: make(map[string]Task),
	}
}

func (r *MemoryTaskRepository) Create(ctx context.Context, task *Task) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.tasks[task.ID]; exists {
		return ErrConflict
	}

	r.tasks[task.ID] = *task
	return nil
}

func (r *MemoryTaskRepository) Get(ctx context.Context, id string) (*Task, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	task, ok := r.tasks[id]
	if !ok {
		return nil, ErrNotFound
	}

	copy := task
	return &copy, nil
}

func (r *MemoryTaskRepository) List(ctx context.Context, limit int, cursor string) ([]Task, string, error) {
	select {
	case <-ctx.Done():
		return nil, "", ctx.Err()
	default:
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	ids := make([]string, 0, len(r.tasks))
	for id := range r.tasks {
		ids = append(ids, id)
	}

	// A real implementation would use an ordered database index.
	// This in-memory example keeps the pagination contract visible.
	start := 0
	if cursor != "" {
		for i, id := range ids {
			if id == cursor {
				start = i + 1
				break
			}
		}
	}

	end := start + limit
	if end > len(ids) {
		end = len(ids)
	}

	items := make([]Task, 0, end-start)
	for _, id := range ids[start:end] {
		items = append(items, r.tasks[id])
	}

	next := ""
	if end < len(ids) {
		next = ids[end-1]
	}

	return items, next, nil
}

type TaskService struct {
	repo TaskRepository
}

func NewTaskService(repo TaskRepository) *TaskService {
	return &TaskService{repo: repo}
}

func (s *TaskService) Create(ctx context.Context, req CreateTaskRequest) (*Task, error) {
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return nil, errors.New("name is required")
	}
	if req.Priority < 0 || req.Priority > 100 {
		return nil, errors.New("priority must be between 0 and 100")
	}

	task := &Task{
		ID:        "tsk_" + strconv.FormatInt(time.Now().UnixNano(), 10),
		Name:      req.Name,
		Priority:  req.Priority,
		Status:    "queued",
		CreatedAt: time.Now().UTC(),
	}

	if err := s.repo.Create(ctx, task); err != nil {
		return nil, err
	}

	return task, nil
}

type ErrorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type Handler struct {
	service *TaskService
}

func (h *Handler) CreateTask(w http.ResponseWriter, r *http.Request) {
	var req CreateTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body is not valid JSON")
		return
	}

	task, err := h.service.Create(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, task)
}

func (h *Handler) GetTask(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/tasks/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid_id", "task id is required")
		return
	}

	task, err := h.service.repo.Get(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "task does not exist")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, task)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var response ErrorResponse
	response.Error.Code = code
	response.Error.Message = message
	writeJSON(w, status, response)
}

func main() {
	repo := NewMemoryTaskRepository()
	service := NewTaskService(repo)
	handler := &Handler{service: service}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/tasks", handler.CreateTask)
	mux.HandleFunc("/v1/tasks/", handler.GetTask)

	server := &http.Server{
		Addr:              ":8080",
		Handler:           mux,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Fatal(server.ListenAndServe())
}
```

This intentionally keeps storage simple. In production, the repository implementation would normally use a durable database and an indexed ordering key for cursor pagination.

## 8. Example usage

Create a task:

```bash
curl -X POST http://localhost:8080/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"name":"rebuild-index","priority":80}'
```

Fetch it:

```bash
curl http://localhost:8080/v1/tasks/tsk_...
```

A production client should treat HTTP status codes and structured error codes as protocol semantics, not parse human-readable messages.

## 9. Production considerations

Concurrency: handlers execute concurrently. Shared mutable state must be synchronized, and the database should remain the authoritative concurrency boundary for persistent state.

Scalability: keep API instances stateless. Bound request body size, response size, and query limits. Use pagination for collections.

Failure handling: distinguish validation failures, authorization failures, conflicts, dependency failures, and timeouts. Clients need to know which failures are retryable.

Idempotency: retryable writes need explicit semantics. For example, a client timeout after a successful database commit must not necessarily result in a second resource.

Observability: record request count, latency distributions, status codes, request size, response size, dependency latency, and saturation. Avoid logging credentials, tokens, or sensitive payloads.

Compatibility: additive schema evolution is safer than changing existing fields. Contract tests can detect accidental breaking changes before deployment.

Security: authenticate and authorize at the boundary, validate untrusted input, enforce payload limits, and avoid exposing internal database identifiers unless they are part of the intended contract.

## 10. Design tradeoffs

REST vs RPC: REST gives broadly understood HTTP semantics and resource-oriented contracts. gRPC can provide stronger schemas and efficient internal service-to-service communication. Do not force REST semantics onto latency-sensitive internal RPC where a command-oriented protocol is a better fit.

Offset vs cursor pagination: offsets are simple and convenient for stable, small datasets. Cursors scale better for large, changing collections but require an ordering strategy and more careful API semantics.

Synchronous vs asynchronous APIs: synchronous APIs give clients immediate outcomes but couple request latency to downstream work. Asynchronous APIs improve isolation and throughput but introduce job state, polling or callbacks, and eventual consistency.

URL versioning vs header/media-type versioning: URL versioning is operationally obvious and easy to route. Header-based versioning can keep resource URLs stable but makes debugging and routing less explicit.

Local validation vs database validation: early validation reduces wasted work and latency. The database must still enforce invariants that require atomicity or cross-request concurrency control.

Do not use an abstraction when it hides important semantics. An API should make behavior clearer, not merely provide another layer around a database call.

## 11. Connection to previous lessons

Day 1 established requirements and constraints. API design turns those constraints into an externally observable contract.

If Day 1 says the system must sustain a given request rate, the API must bound expensive operations and collection sizes. If Day 1 specifies a latency target, synchronous endpoints must have bounded downstream work. If availability matters, retry behavior and idempotency become part of the API contract.

Today's API boundary is therefore the first concrete place where the earlier non-functional requirements become implementation constraints.

## 12. What comes next

Data modeling follows naturally.

Once the API defines resources and operations, the next question is how those resources are represented and indexed in persistent storage. The progression will move from API resource models to database schema, access patterns, indexes, and consistency implications.

## Key Takeaways

- An API is a compatibility boundary, not just an HTTP handler.
- Define semantics for writes, errors, pagination, retries, and evolution explicitly.
- Bound collection size and use pagination for scalable APIs.
- Idempotency is essential when distributed retries can duplicate writes.
- Keep transport, application logic, and persistence responsibilities separate.
- Design APIs from system constraints rather than adding constraints after the endpoint exists.

## Concept Map

```
Requirements / Constraints
        |
        v
    API Design
        |
        +----> Data Modeling
        |          |
        |          v
        |       Indexing
        |
        +----> Idempotency
        |          |
        |          v
        |        Retries
        |
        +----> Pagination
        |          |
        |          v
        |     Large-scale reads
        |
        +----> Caching / Queues
```

## Exercise

Design the API contract for a distributed job submission service.

Specify:

1. Create-job request and response.
2. Job status retrieval.
3. Cancellation.
4. Idempotency semantics for job creation.
5. Pagination for job history.
6. Error model and retryability.
7. What should return synchronously versus asynchronously.

Do not design the database or distributed scheduler yet. Keep the exercise focused on the API contract.

## Progress

Added as Day 2 in the dedicated `system-design/` learning journal. Day 1 was reconstructed from the repository's previous tracker so the journal has a durable history.

## Most Important Mental Model

An API is a protocol between independently evolving systems, so its primary job is to make behavior and failure semantics stable and explicit.
