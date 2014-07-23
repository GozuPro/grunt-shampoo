/*
 * grunt-shampoo
 * https://github.com/soapcreative/grunt-shampoo
 *
 * Copyright (c) 2014 Soap Creative
 * Licensed under the MIT license.
 */

'use strict';

var request = require("request"),
    async = require("async"),
    sha256 = require("sha256"),
    fs = require("fs"),
    knox = require("knox"),
    deferred = require('underscore.deferred'),
    crypto = require('crypto');

var client = null;

module.exports = function(grunt) {
  grunt.registerMultiTask( "shampoo", "Retrieve content from the Shampoo CMS API on shampoo.io.", function() {

    var _ = grunt.util._;

    function makeClient(options) {
        
        return knox.createClient(_.pick(options, [
        'region', 'endpoint', 'port', 'key', 'secret', 'access', 'bucket', 'secure', 'headers', 'style'
        ]));

    };


    function getMediaAssets( obj, collection, mediaOut ){

      for( var key in obj ) {

        if( typeof obj[key] === "object" ){
              
          getMediaAssets( obj[key], collection, mediaOut );

        } else if(typeof obj[key] == "string") {

            if(obj[key].indexOf(".amazonaws.com/") >= 0 ) {
                
                var dest = obj[key].replace("http://", "").replace("https://", "");
                dest = dest.split("/");
                dest.shift();
                dest = dest.join("/");

                if(collection.indexOf(dest) < 0) {
                  collection.push(dest);
                }

                obj[key] = mediaOut + dest;


            }

        }
      }

      return collection;

    }

    function verifyDownload(dest, mediaOut, doneCallback) {

      var relativeToBucket = "";

      relativeToBucket = dest;
      dest = mediaOut + dest;

      //first check to see if the dest file exists in our project
      fs.exists(dest, function(fileExists) {

        if (fileExists) {

          //if the file exists, lets check to see if it needs to be re-downloaded.
          
          client.headFile(relativeToBucket, function(err, res) {

            var localHash = "";
            var remoteHash = res.headers.etag.replace(/"/g, '');
            //grab the remote etag from AWS, and compare it against a md5 of our local file.

            fs.readFile(dest, function (err, data) {

              localHash = crypto.createHash('md5').update(data).digest('hex');

              if (remoteHash === localHash) {
                
                //we don't need to download this file - its the same as what we've got.
                doneCallback();
                return;

              } else {

                //the file hashes don't match, so we need to re-download it.
                downloadFile(dest, relativeToBucket, doneCallback);

              }

            });

          });
        
        } else {

          //we don't have this file in our system, so download it.

          var destDir = dest.split("/");
          destDir.pop();
          destDir = destDir.join("/");

          fs.exists(destDir, function(dirExists) {
            
            //create the directory if it doesn't exist.
            if(dirExists) {

              downloadFile(dest, relativeToBucket, doneCallback);

            } else {

              fs.mkdir(destDir, function(err){
                
                downloadFile(dest, relativeToBucket, doneCallback);

              });

            }

          });

        }

      });

    }

    function writeJsonFile(out, body) {

      grunt.file.write(out, JSON.stringify(body));

    }

    function downloadFile(dest, src, doneCallback) {

      // Create a local stream we can write the downloaded file to.
      grunt.log.ok("Grabbing down: " + dest);

      var file = fs.createWriteStream(dest);
      file.on("error", function(e) {
        grunt.log.error("Error with filesystem creating write: " + dest);
      })

      client.getFile(src, function (err, res) {
        // If there was an upload error or any status other than a 200, we
        // can assume something went wrong.

        if (err || res.statusCode !== 200) {
          grunt.log.error("Error getting the file: " + dest);
          //return dfd.reject(makeError(MSG_ERR_DOWNLOAD, src, err || res.statusCode));
          doneCallback();
          return;
        }

        res
          .on('data', function (chunk) {
            file.write(chunk);
          })
          .on('error', function (err) {
            //return dfd.reject(makeError(MSG_ERR_DOWNLOAD, src, err));
            grunt.log.error("Hit an error thrown from AWS on file: " + dest);
            doneCallback();
            return;
          })
          .on('end', function () {
            file.end();
            doneCallback();
          });
      });

    }

    var options = this.options({
      ignoreErrors: false,
      api: 1,
      format: "json",
      type: "dump",
      query: "single-file",
      out: "data/content.json",
      mediaOut: "",
      privateConfig: {}
    });

    var done = this.async();

    var invalids = [];

    if (!options.domain) {
      invalids.push("domain");
    }

    if (!options.format) {
      invalids.push("format");
    }

    if (!options.type) {
      invalids.push("type");
    }

    if (!options.query) {
      invalids.push("query");
    }

    if (!options.out) {
      invalids.push("out");
    }

    if (!options.privateConfig.shampoo.key || !options.privateConfig.shampoo.secret) {
      grunt.log.error( "API Key and Secret required. Get them from your Shampoo account under 'Settings'.");
    }

    if (invalids.length > 0) {
      grunt.log.error('grunt-shampoo is missing following options:', invalids.join(', '));
      return false;
    }

    var requestId = (new Date()).getTime() + "" + Math.floor(Math.random()*10000000);
    var token = sha256( options.secret + options.key + requestId );

    var url = "http://" + options.domain + "/api/v" + options.api + "/" + options.type + "/" + options.format + "/" + options.query + "?token=" + token + "&requestId=" + requestId;
    var mediaAssets = [];

    request(url, function( error, response, body ) {
      response = response || { statusCode: 0 };
      body = JSON.parse( body );
      if( body.error ) {
        grunt.log.error( "Error: " + body.message );
        return done( body.message );
      } else if (error) {
        return done(error);
      } else if ((response.statusCode < 200 || response.statusCode > 399)) {
        return done(response.statusCode + " " + body);
      }
      
      grunt.log.ok(response.statusCode);

      if(options.out) {
        

        if(options.mediaOut != "") {

            //if mediaOut doesn't end in "/", add it in.
            if (options.mediaOut.substring(options.mediaOut.length-1) != "/") {
                options.mediaOut += "/";
            }

            client = makeClient(options.privateConfig.aws);
            mediaAssets = getMediaAssets(body, mediaAssets, options.mediaOut);

            writeJsonFile(options.out, body);

            var loadCounter = 0;
            for(var key in mediaAssets) {
                var asset = mediaAssets[key];
                verifyDownload(asset, options.mediaOut, function() {

                  loadCounter++;
                  if(loadCounter == mediaAssets.length) {
        
                    done();

                  }

                });
            }

        } else {

          writeJsonFile(options.out, body);
          done();

        }

        grunt.log.ok( "Content saved locally" );

      }

    });

  });
  
};
