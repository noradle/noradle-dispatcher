mechanism/design
================

static architecture
--------------------

architecture graph, [more][basic network architecture]

```text
          (multiplexed)               (utl_tcp)
. clients  ===========>  dispatcher  <----------  oracle processes
 (node.js)                (node.js)                  (oracle)
                             ^
.                      monitor/console
```

* [NORADLE database connectivity(.docx)](http://docs.noradle.com/infrastructure/noradle_db_connectivity_4000.docx)
* [NORADLE robustness(.docx)](http://docs.noradle.com/infrastructure/noradle_robustness_4000.docx)

  [basic network architecture]: https://github.com/kaven276/noradle/wiki/The-creative-dispatcher-architecture-of-NORADLE

explain in Chinese

* 利用 oracle dbms_tcp 包来实现到 node.js 的连接
* 利用 node.js 做 http 服务接入
* 启用 node.js 的 dispatcher 来监听和接续 client/oracle/console 的连接
* 多 oracle 进程处理 pl/sql servlet
* client 连库采用永久连接、自动连接自动恢复机制
* multiplex requests from client to dispatcher
* 框架/容器部分代码完全只读，支持 data-guard readonly 环境
* 各节点之间的连接都支持自动恢复、死链接自动检测(由于NAT)
* oracle 只认 exec env NV，不知 http，只设响应头而不做实际处理
* node.js 侧帮助完成上述处理，使得 oracle 只聚焦 servlet 逻辑
* node.js 侧为标准的http handler，可以挂接到原生或express等第三方库

design considerations
---------------------

* dispatcher should have only clear well defined, strictly constraint, minimum functions. 
 Be stable through versions of NORADLE. So clients will not be affected by the change of dispatcher.
* dispatcher must long time hold OSP's reverse connections
* all client connected to dispatcher to communicate with oracle
* dispatcher only act as a request/response frame relay worker, don't know any internal format of the frames
* dispatcher communicate with client/OSP with control frames, support system management requirement
* all OSPs should be max utilized by all clients
* clients, OSPs, monitors/consoles connect to dispatcher with the only one port, make work easy
* by all node connected to dispatcher, all statistics should be got by connect to dispatcher

bootstrap
----------

1. oracle processes call UTL_TCP to connect to dispatcher, identified by oSlotID from 1
2. dispatcher hold OSP connections, put their oSlotID to free list
3. client connected to dispatcher
4. dispatcher tell client its concurrency quota
5. client hold virtual connections whose cSlotID from 1 up to its concurrency quota, put cSlotIDs to free list

request/response normal flow
----------------

1. client is about to send a request
2. client DBDriver found one free cSlotID from free list
3. client send the request's frames with cSlotID set to above free cSlotID
4. dispatcher accept frames from the client
5. dispatcher found the head frame
6. dispatcher get a free oSlotID from free list
7. dispatcher bind the client's cSlotID with the oSlotID each other
8. dispatcher found the remaining frames including the end frame
9. dispatcher know the frames from the client with the same cSlotID belong to the same request
10. dispatcher relay the frames to the OSP with the bound oSlotID
11. OSP got frames a request, no other request's frame in the middle of them
12. OSP send response frames to dispatcher with the request's cSlotID unchanged
13. dispatcher know this OSP is bound with which client, and its cSlotID
14. dispatcher relay the response frames to the bound client
15. if dispatcher found the end frame of response, it will unbound (client,cSlotID) with (oSlotID) each other.
so OSP identified by the released oSlotID can be recycled, avoid resource leakage.
16. with the help of cSlotID in the response frame, client can direct the response frames to the corresponding request
17. if client found response frame is a end frame, client will release the cSlotID back to freelist,
so one concurrency quota will be recycled, avoid concurrency resource leakage.

control frame
==============

features
==========

## server controls

* every client have a virtual connection pool of oracle server processes on the single connection to dispatcher

## client take easy

client specified dispatcher address, use it simply

* client won't worry abort connection/dispactcher breakage and retry connect, it's automatically done
* client won't worry abort how many connections/concurrency it need, dispatcher will tell client
* client won't wait connected callback to send a request, client just send request, if connection to dispatcher is not established, noradle will just queue it, when connection is ok, all queued request will sent

## well utilized OSP

oracle server processes is well utilized

* a constant number of oracle server processes for noradle is kept, don't worry abort overwhelm of processes
* a single client can not keep redundant virtual OSP quota while other client is lack of OSP quota
* busy processes is reused for new request when it's freed, minimize process switch

## multiplexing

client's concurrent request send over a multiplexed TCP connection to dispatcher

* TCP three-steps handshake is avoided
* TCP slow startup is avoided
* OS resourced for network and file descriptor is minimized
* control frame is supported (keep-alive, kill node, concurrency quota setting, ...)

## single unified listening port

dispatcher listen just only one port,
different type of node will connect with type id in socket head,
so dispatcher can distinguish them and treat them accordingly.
OSPs, clients, monitors/consoles all connect to dispatcher's unified listening port.

* network management is easy
* support connect dispatcher by http tunnel, generally within the pure single http reverse proxy

## centralized statistics service

through runtime statistics is collected by dispatcher, client driver, OSP, 
dispatcher can get all statistics from all types of node,
so a monitor/console app can just connect to dispatcher to get all statistics,
very convenient, no network setup/configuration overhead.