var RedisPool  = require('./redis_pool')
  , MMLBuilder = require('./mml_builder')
  , Step = require('step');

// @param redis_opts
//    configuration object for the RedisPool,
//    see details in redis_pool.js
//
// @param optional_args
//    optional configurations. valid elements:
//    gc_prob: probability of GC running to cleanup expired layergroup configs
//    *: anything else that is accepted by mml_builder "optional_args"
//       parameter, see mml_builder.js
//    
//
var MMLStore = function(redis_opts, optional_args) {  

  var redis_pool = new RedisPool(redis_opts),
      me = {};

  optional_args = optional_args || {};


  // @param callback(err, payload) called on initialization
  me.mml_builder = function(opts, callback){
    var gc_probability = optional_args.gc_prob || 0.01;
    if ( gc_probability && Math.random() < gc_probability ) me.gc();
    return new MMLBuilder(redis_pool, opts, optional_args, callback);
  };

  var gcruns = 0;
  me.gcrunning = 0;
  me.gc = function(callback){

    if ( me.gcrunning ) {
      console.log(me.gcrunning + " already running");
      if ( callback ) callback();
      return;
    }
    var id = "GC" + (++gcruns);
    me.gcrunning = id;

    console.log(id + ": cycle starts");

    var redis_client;
    var redis_db = 0;
    Step(
      function getRedisClient(){
        redis_pool.acquire(redis_db, this);
      },
      function getTokens(err, data){
        if (err) throw err;
        redis_client = data;
        redis_client.KEYS('map_style|*|~*', this);
      },
      function expireTokens(err, matches){
        if (err) throw err;
        console.log(id +": " + matches.length + ' key matches');
        var next = this;
        var processNext = function() {
          if ( ! matches.length ) {
            next(null);
            return;
          }
          var k = matches.shift();
          var params = RegExp(/map_style\|([^|]*)\|~([^|]*)/).exec(k);
          if ( ! params ) {
            console.log(id + " key " + k + " is INVALID, skipping");
            processNext();
            return;
          } 
          console.log(id +": match " + k + ' is valid');
          var db = params[1];
          var token = params[2];
          var mml_builder = new MMLBuilder(redis_pool, {dbname:db, token:token},
                                           optional_args, function(err, payload)
          {
              if ( err ) {
                console.log(id +": " + err);
                processNext();
                return;
              }

              console.log(id +": mml_builder for match " + k + ' constructed');

              mml_builder.getStyle(function(err, data) {
                if ( err ) {
                  console.log(id + ": " + token + ' ' + err.message);
                  processNext();
                  return;
                }
                var expires = data.accessed_at + (data.ttl * 1000);
                var now = Date.now();
                var secsleft = Math.round((expires-now)/10)/100;
                if ( now < expires ) {
                  console.log(id + ": " + token + ' has '
                    + secsleft
                    + ' more seconds before expiration');
                  processNext();
                  return;
                }
                mml_builder.delStyle(function(err, data) {
                  if ( err ) {
                    console.log(id + ": " + token + ' expired '
                      + (-secsleft)
                      + ' seconds ago could not be deleted: '
                      + err.message );
                  }
                  else {
                    console.log(id + ": " + token + ' expired '
                      + (-secsleft) + ' seconds ago');
                  }
                  processNext();
                });
              });
          });

        };
        processNext();
      },
      function finish(err, data){
        if (redis_client)
          redis_pool.release(redis_db, redis_client);
        if (err) console.log(id + ": " + err.message);

        console.log(id + ": cycle ends");
        delete me.gcrunning;
        if ( callback ) callback(err);
      }
    );
  }

  return me;    
};

module.exports = MMLStore;
