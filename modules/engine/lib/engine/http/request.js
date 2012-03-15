/*
 * Copyright 2012 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var _ = require('underscore'),
    assert = require('assert'),
    eventTypes = require('../event-types.js'),
    http = require('http'),
    https = require('https'),
    URI = require('uri'),
    response = require('./response.js'),
    zlib = require('zlib'),
    uuid = require('node-uuid');

exports.send = function(args) {

    var client, options;
    var uri, heirpart, authority, host, port, path, useProxy = false, proxyHost, proxyPort;

    var isTls = args.uri.indexOf('https://') == 0;
    uri = new URI(args.uri, false);

    heirpart = uri.heirpart();
    assert.ok(heirpart, 'URI [' + args.uri + '] is invalid');
    authority = heirpart.authority();
    assert.ok(authority, 'URI [' + args.uri  + '] is invalid');
    host = authority.host();
    assert.ok(host, 'Host of URI [' + args.uri  + '] is invalid');
    port = authority.port() || (isTls ? 443 : 80);
    assert.ok(port, 'Port of URI [' + args.uri  + '] is invalid');
    path = (heirpart.path().value || '') + (uri.querystring() || '');

    if(args.config.proxy) {
        var proxyConfig = args.config.proxy;
        if (proxyConfig[host] && !proxyConfig[host].host) {
            useProxy = false;
        }
        else if (proxyConfig[host] && proxyConfig[host].host) {
            proxyHost = proxyConfig[host].host;
            proxyPort = proxyConfig[host].port;
            useProxy = true;
        }
        else if (proxyConfig['*']) {
            proxyHost = proxyConfig['*'].host;
            proxyPort = proxyConfig['*'].port;
            useProxy = true;
        }
    }

    options = {
        host: useProxy ? proxyHost : host,
        port: useProxy? proxyPort : port,
        path: useProxy? uri.scheme() + '//' + host + path : path,
        method: args.method,
        headers: args.headers
    };
    client = isTls ? https : http;

    // Send
    sendMessage(args, client, options, 0);
}

function putInCache(key, cache, result, res, timeout) {
    if (key && cache) {
        cache.put(key, {result:result, res:{headers:res.headers,
            statusCode:res.statusCode}}, timeout);
    }
}

var followRedirects = true, maxRedirects = 10;

function sendHttpRequest(client, options, args, start, timings, reqStart, key, cache, timeout, uniqueId, status, retry, redirects) {
    var clientRequest = client.request(options, function (res) {
        if (followRedirects && res.statusCode >= 300 && res.statusCode < 400) {
            res.socket.destroy();
            if (res.headers.location) {
                if (redirects++ >= maxRedirects) {
                    args.logEmitter.emitError(args.httpReqTx.event, 'Error with uri - ' + args.uri + ' - ' +
                        'Exceeded max redirects (' + maxRedirects + '). In a loop? ' + (Date.now() - start) + 'msec');
                    var err = new Error('Exceeded max redirects');
                    err.uri = args.uri;
                    err.status = 502;
                    return args.httpReqTx.cb(err);
                }

                var location = new URI(res.headers.location, false);
                options.host = location.heirpart().authority().host();
                options.port = location.heirpart().authority().port();
                options.path = location.heirpart().path();

                args.logEmitter.emitEvent(args.httpReqTx.event, 'being redirected for the ' + redirects + ' time, ' +
                    'going to ' + options.host + ':' + options.port + options.path + ' - ' + args.uri + ' - ' + (Date.now() - start) + 'msec');
                sendHttpRequest(client, options, args, start, timings, reqStart, key, cache, timeout, uniqueId, status, retry, redirects);
                return;
            } else {
                args.logEmitter.emitError(args.httpReqTx.event, 'Error with uri - ' + args.uri + ' - ' +
                    'Received status code ' + res.statusCode + ', but Location header was not provided' +
                    ' ' + (Date.now() - start) + 'msec');
                var err = new Error('Missing Location header in redirect');
                err.uri = args.uri;
                err.status = 502;
                return args.httpReqTx.cb(err);
            }
        }

        var bufs = []; // array for bufs for each chunk
        var responseLength = 0;
        var contentEncoding = res.headers['content-encoding'];
        var zipped = false, unzip;
        var result;
        if (contentEncoding) {
            contentEncoding = contentEncoding.toLowerCase();
            if (contentEncoding === 'gzip') {
                unzip = zlib.createGunzip();
            }
            else if (contentEncoding === 'deflate') {
                unzip = zlib.createInflate();
            }
            else {
                var err = new Error('Content-Encoding \'' + contentEncoding + '\' is not supported');
                err.uri = args.uri;
                err.status = 502;
                args.logEmitter.emitError(args.httpReqTx.event, 'Error with uri - ' + args.uri + ' - ' +
                    'Content encoding ' + contentEncoding + ' is not supported' +
                    ' ' + (Date.now() - start) + 'msec');
                res.socket.destroy();
                return args.httpReqTx.cb(err);
            }
            zipped = true;

            unzip.on('data', function (chunk) {
                bufs.push(chunk);
            });
            unzip.on('end', function () {
                result = response.parseResponse(timings, reqStart, args, res, bufs);
                putInCache(key, cache, result, res, timeout);
                response.exec(timings, reqStart, args, uniqueId, res, start, result, options, status);
            });
            unzip.on('error', function (err) {
                var err = new Error('Corrupted stream');
                err.uri = args.uri;
                err.status = 502;
                args.logEmitter.emitError(args.httpReqTx.event, 'Error with uri - ' + args.uri + ' - ' +
                    'Stream is corrupted' +
                    ' ' + (Date.now() - start) + 'msec');
                res.socket.destroy();
                return args.httpReqTx.cb(err);
            });
        }

        res.on('data', function (chunk) {
            if (zipped) {
                // TODO Check for corrupted stream. Empty 'bufs' may indicate invalid stream
                unzip.write(chunk);
            }
            else {
                // Chunk is a buf as we don't set any encoding on the response
                bufs.push(chunk);
            }
            responseLength += chunk.length;

            var maxResponseLength = getMaxResponseLength(args.config, args.logEmitter);

            if (responseLength > maxResponseLength) {
                var err = new Error('Response length exceeds limit');
                err.uri = args.uri;
                err.status = 502;

                args.logEmitter.emitError(args.httpReqTx.event, 'error with uri - ' + args.uri + ' - ' +
                    'response length ' + responseLength + ' exceeds config.maxResponseLength of ' + maxResponseLength +
                    ' ' + (Date.now() - start) + 'msec');
                res.socket.destroy();
                return args.httpReqTx.cb(err);
            }
        });
        res.on('end', function () {
            if (zipped) {
                unzip.end();
            }
            else {
                result = response.parseResponse(timings, reqStart, args, res, bufs);
                putInCache(key, cache, result, res, timeout);
                response.exec(timings, reqStart, args, uniqueId, res, start, result, options, status);
            }
        });
    });

    if (args.body) {
        clientRequest.write(args.body);
        timings.send = Date.now() - reqStart;
    }
    clientRequest.on('error', function (err) {
        args.logEmitter.emitError(args.httpReqTx.event, 'error with uri - ' + args.uri + ' - ' +
            err.message + ' ' + (Date.now() - start) + 'msec');
        // For select, retry once on network error
        if (retry === 0 && args.statement.type === 'select') {
            args.logEmitter.emitEvent(args.httpReqTx.event, 'retrying - ' + args.uri + ' - ' + (Date.now() - start) + 'msec');
            sendMessage(args, client, options, 1);
        }
        else {
            err.uri = args.uri;
            err.status = 502;
            return args.httpReqTx.cb(err);
        }
    });
    clientRequest.end();
}

function sendMessage(args, client, options, retry) {
    var status, start = Date.now(), key = args.key, cache = args.cache,
        timeout = args.timeout || 3600;
    var reqStart = Date.now();
    var timings = {
        "blocked": -1,
        "dns": -1,
        "connect": -1,
        "send": -1,
        "wait": -1,
        "receive": -1
    };

    if(args.emitter) {
        var uniqueId = uuid();
        var packet = {
            line: args.statement.line,
            id: uniqueId,
            uuid: args.httpReqTx.event.uuid,
            method: options.method,
            uri: args.uri,
            headers: [],
            body: args.body,
            start: reqStart,
            type: eventTypes.STATEMENT_REQUEST
        };
        if(args.body) {
            packet.body = args.body;
        }
        _.each(args.headers, function(v, n) {
            packet.headers.push({
                name: n,
                value: v
            });
        });
        args.emitter.emit(packet.type, packet);
    }

    if (key && cache) {
        cache.get(key,function(err,result){
            if(err || !result.data){
                sendHttpRequest(client, options, args, start, timings, reqStart,
                    key, cache, timeout, uniqueId, status, retry, 0);
            }
            else {
                response.exec(timings, reqStart, args, uniqueId, res, result.start, result.result, options, status);
            }
        });
    }
    else {
        sendHttpRequest(client, options, args, start, timings, reqStart, key, cache, timeout, uniqueId, status, retry, 0);
    }
}

function getMaxResponseLength(config, logEmitter) {
    if(config && config.maxResponseLength) {
        return config.maxResponseLength;
    }
    else {
        var max = 10000000; // default to 10,000,000
        logEmitter.emitWarning('config.maxResponseLength is undefined! Defaulting to ' + max);
        return max;
    }
}
