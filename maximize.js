#!/usr/bin/env node

var http = require('http');
var https = require('https');
var url = require('url');

var ArgumentParser = require('argparse').ArgumentParser;
var falafel = require('falafel');
var beautify = require('js-beautify');
var Seq = require('seq');
var sourceMap = require('source-map');

var parser = new ArgumentParser({
  addHelp: true,
  description: 'Deobfuscate and beautify JavaScript code with source maps',
});

parser.addArgument(['url'], {help: 'URL of javascript to maximize', nargs: 1});
parser.addArgument(['-b', '--beautify-opts'], {help: 'JS Beautifier options in JSON format', nargs: 1, defaultValue: '{}'});
var args = parser.parseArgs();

try {
  args.beautify_opts = JSON.parse(args.beautify_opts);
} catch (e) {
  console.error('Failed to parse JS Beautifier options: ' + e.message);
  process.exit(-1);
}

function fetch(src) {
  switch (url.parse(src).protocol) {
    case 'http:':
      http.get(src, this.ok).on('error', this);
      break;
    case 'https:':
      https.get(src, this.ok).on('error', this);
      break;
    default:
      console.error('Bad URL: URL must be an HTTP(S) resource');
      process.exit(-1);
  }
}

Seq()
  .seq('fetch_src', function() {
    fetch.call(this, args.url[0]);
  })
  .seq('code', function(res) {
    var self = this;

    if (res.statusCode < 200 || res.statusCode > 300) {
      console.error('Failed to fetch script: status code ' + res.statusCode);
      process.exit(-1);
    }

    var data = [];
    res.on('data', function(chunk) {
      data.push(chunk);
    });

    res.on('end', function() {
      var code = Buffer.concat(data).toString();

      if ('SourceMap' in res.headers)
        self.ok(code, res.headers.SourceMap);
      else if ('X-SourceMap' in res.headers)
        self.ok(code, res.headers['X-SourceMap']);
      else
        self.ok(code);
    });

    res.on('close', function() {
      console.error('Failed to retrieve entire script');
      process.exit(-1);
    });
  })
  .seq('mapUrl', function(code, mapUrl) {
    if (mapUrl)
      return this.ok(mapUrl);

    var sourceMappingURLRE = /^\/\/[@#] sourceMappingURL=(.*)$/m;
    var info = sourceMappingURLRE.exec(code);
    if (!info) {
      console.error('Failed to find sourceMappingURL tag in script');
      process.exit(-1);
    }

    var srcmap = info[1];
    var srcmapUri = url.parse(srcmap);
    var srcUri = url.parse(args.url[0]);

    if (!srcmapUri.protocol) {
      srcmapUri.protocol = srcUri.protocol;
      srcmapUri.auth = srcUri.auth;
      srcmapUri.host = srcUri.host;
    }

    if (srcmap[0] !== '/')
      srcmapUri.pathname = srcUri.pathname.slice(0, srcUri.pathname.lastIndexOf('/') + 1) + srcmap;

    this.ok(url.format(srcmapUri));
  })
  .seq('fetch_map', fetch)
  .seq('map', function(res) {
    var self = this;

    if (res.statusCode < 200 || res.statusCode > 300) {
      console.error('Failed to fetch source map: status code ' + res.statusCode);
      process.exit(-1);
    }

    var data = [];
    res.on('data', function(chunk) {
      data.push(chunk);
    });

    res.on('end', function() {
      self.ok(new sourceMap.SourceMapConsumer(Buffer.concat(data).toString()));
    });

    res.on('close', function() {
      console.error('Failed to retrieve entire source map');
      process.exit(-1);
    });
  })
  .seq('process', function(map) {
    var sourceName='';
    var deobfuscated = falafel(this.vars.code, {locations: true}, function(node) {
      var orig;
       if (node.id) {
        orig = map.originalPositionFor({line: node.id.loc.start.line, column: node.id.loc.start.column});
        if (orig.name) {
          if(sourceName!=orig.source) {
              sourceName=orig.source;
              node.id.update(orig.name +'/*'+orig.source+'*/');
            } else {
              node.id.update(orig.name);
            }
          }
      } else if (node.type === 'Identifier') {
        orig = map.originalPositionFor({line: node.loc.start.line, column: node.loc.start.column});
        if (orig.name) {
          if(sourceName!=orig.source) {
            sourceName=orig.source;
            node.update(orig.name +'/*'+orig.source+'*/');
          } else {
             node.update(orig.name);
          }
        }
      }
    });

    var beautified = beautify(deobfuscated.toString(), args.beautify_opts);
    var re = /^(.*)(\/\*[a-z0-9\-_\/\.]+\*\/)(.*)$/igm;
    beautified = beautified.replace(re,'\r\n\r\n\r\n\r\n/**************************************************************/\r\n\r\n$2\r\n\r\n$1$3');

    console.log(beautified);
  })
  ['catch'](function(err, stage) {
    console.error('Failed in stage ' + stage + ': ' + err.stack);
    process.exit(-1);
  });
