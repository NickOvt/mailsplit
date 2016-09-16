'use strict';

// Helper class to rewrite nodes with specific mime type

const Transform = require('stream').Transform;
const libmime = require('libmime');
const PassThrough = require('stream').PassThrough;

/**
 * NodeRewriter Transform stream. Updates content for all nodes with specified mime type
 *
 * @constructor
 * @param {String} mimeType Define the Mime-Type to look for
 * @param {Function} rewriteAction Function to run with the node content
 */
class NodeRewriter extends Transform {
    constructor(filterFunc, rewriteAction) {
        let options = {
            readableObjectMode: true,
            writableObjectMode: true
        };
        super(options);

        this.filterFunc = filterFunc;
        this.rewriteAction = rewriteAction;

        this.decoder = false;
        this.encoder = false;
        this.continue = false;
    }

    _transform(data, encoding, callback) {
        this.processIncoming(data, callback);
    }

    _flush(callback) {
        if (this.decoder) {
            if (this.decoder.$reading) {
                this.decoder.$done = callback;
                return;
            } else {
                this.decoder.end();
            }
        }
        return callback();
    }

    processIncoming(data, callback) {
        if (this.decoder && data.type === 'body') {
            // data to parse
            this.decoder.write(data.value);
        } else if (this.decoder && data.type !== 'body') {
            // stop decoding.
            // we can not process the current data chunk as we need to wait until
            // the parsed data is completely processed, so we store a reference to the
            // continue callback
            this.continue = () => {
                this.continue = false;
                this.decoder = false;
                this.encoder = false;
                this.processIncoming(data, callback);
            };
            return this.decoder.end();
        } else if (data.type === 'node' && this.filterFunc(data)) {
            // found matching node, create new handler
            this.emit('node', this.createDecoder(data));
        } else if (this.readable) {
            // we don't care about this data, just pass it over to the joiner
            this.push(data);
        }
        callback();
    }

    createDecoder(node) {
        this.decoder = node.getDecoder();

        if (['base64', 'quoted-printable'].includes(node.encoding)) {
            this.encoder = node.getEncoder();
        } else {
            this.encoder = node.getEncoder('quoted-printable');
        }

        let decoder = this.decoder;
        let encoder = this.encoder;
        let firstChunk = true;
        decoder.$reading = false;
        decoder.$done = false;

        let readFromEncoder = () => {
            decoder.$reading = true;

            let data = encoder.read();
            if (data === null) {
                decoder.$reading = false;
                if (typeof decoder.$done === 'function') {
                    decoder.end();
                    decoder.$done();
                }
                return;
            }

            if (firstChunk) {
                firstChunk = false;
                if (this.readable) {
                    this.push(node);
                }
            }

            let writeMore = true;
            if (this.readable) {
                writeMore = this.push({
                    node,
                    type: 'body',
                    value: data
                });
            }

            if (writeMore) {
                return setImmediate(readFromEncoder);
            } else {
                encoder.pause();
                this.once('drain', () => encoder.resume());
            }
        };

        encoder.on('readable', () => {
            if (!decoder.$reading) {
                return readFromEncoder();
            }
        });

        encoder.on('end', () => {
            if (firstChunk) {
                firstChunk = false;
                if (this.readable) {
                    this.push(node);
                }
            }

            if (this.continue) {
                return this.continue();
            }
        });

        if (/^text\//.test(node.contentType) && node.flowed) {
            let chunks = [];
            let chunklen = 0;
            let flowDecoder = decoder;
            decoder = new PassThrough();
            flowDecoder.on('error', err => {
                decoder.emit('error', err);
            });

            flowDecoder.on('data', chunk => {
                chunks.push(chunk);
                chunklen += chunk.length;
            });

            flowDecoder.on('end', () => {
                let currentBody = Buffer.concat(chunks, chunklen);
                let content = libmime.decodeFlowed(currentBody.toString('binary'), node.delSp);
                currentBody = Buffer.from(content, 'binary');
                node.flowed = false;
                node.delSp = false;
                node.setContentType();
                decoder.end(currentBody);
            });
        }

        return {
            node,
            decoder,
            encoder
        };
    }
}

module.exports = NodeRewriter;
