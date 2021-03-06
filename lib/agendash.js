var async = require('async')
var semver = require('semver')

module.exports = function (agenda, options) {
  options = options || {}
  const ITEMS_PER_PAGE = 10;
  const CURRENT_PAGE = 1;

  agenda.on('ready', function () {
    agenda._collection.createIndexes([
      {key: { nextRunAt: -1, lastRunAt: -1, lastFinishedAt: -1 }},
      {key: { name: 1, nextRunAt: -1, lastRunAt: -1, lastFinishedAt: -1 }}
    ], function (err, result) {
      if (err) {
        console.warn('Agendash indexes might not exist. Performance may decrease.')
      }
    })
    agenda._mdb.admin().serverInfo(function (err, serverInfo) {
      if (err) throw err
      if (!semver.satisfies(serverInfo.version, '>=2.6.0')) {
        console.warn('Agendash requires mongodb version >=2.6.0.')
      }
    })
  })

  return {
    api: api,
    requeueJobs: requeueJobs,
    deleteJobs: deleteJobs,
    createJob: createJob
  }

  // Static routes
  function api (job, state, total, totalPages, currentPage, itemsPerPage, callback) {
    if (!agenda) {
      return callback('Agenda instance is not ready')
    }
    
    currentPage = currentPage || CURRENT_PAGE ;
    itemsPerPage = itemsPerPage || ITEMS_PER_PAGE ;
    total = total || ITEMS_PER_PAGE ;
        
    async.parallel({
      overview: getOverview,
      jobs: getJobs.bind(this, job, state, total, currentPage, itemsPerPage),
      total: getTotalJobs.bind(this, job, state)
    },
    function (err, apiResponse) {
      if (err) return callback(err.message)
      apiResponse.title = options.title || 'Agendash'
      apiResponse.currentRequest = {
        title: options.title || 'Agendash',
        job: job || 'All Jobs',        
        state: state,
        total: apiResponse.total,  
        itemsPerPage: itemsPerPage,
        totalPages: Math.ceil(apiResponse.total/itemsPerPage),
        currentPage: currentPage     
      }
      // console.log(apiResponse);
      callback(null, apiResponse)
    }
  )
  }

  function requeueJobs (jobIds, callback) {
    if (!agenda) {
      return callback('Agenda instance is not ready')
    }
    try {
      agenda._collection
      .find({_id: {$in: jobIds.map((jobId) => agenda._collection.s.pkFactory(jobId))}})
      .toArray(function (err, jobs) {
        if (err || !jobs.length) {
          return callback('Jobs not found')
        }
        // async.series(jobs.map((job) => (done) => {
        //   var newJob = agenda.create(job.name, job.data)
        //   .save(function () {
        //     done(null, newJob)
        //   })
        // }), function (err, results) {
        //   callback(err, results)
        // })
        const result = jobs.map( (job) => {
          var newJob = agenda.create(job.name, job.data);
          newJob.save();          
        });
        return callback(null, { message: 'success'} );
      })
    } catch (e) {
      callback(e.message)
    }
  }

  function deleteJobs (jobIds, callback) {
    if (!agenda) {
      return callback('Agenda instance is not ready')
    }
    try {
      agenda.cancel({_id: {$in: jobIds.map((jobId) => agenda._collection.s.pkFactory(jobId))}}, function (err, deleted) {
        if (err || !deleted) {
          callback('Jobs not deleted')
        }
        // callback()
      });
      callback(null, { message: 'success'});
    } catch (e) {
      callback(e.message)
    }
  }

  function createJob (jobName, jobSchedule, jobRepeatEvery, jobData, callback) {
    if (!agenda) {
      return callback('Agenda instance is not ready')
    }
    try {
      /*
      TODO: Need to validate user input.
      */
      var job = agenda.create(jobName, jobData)
      if (jobSchedule && jobRepeatEvery) {
        job.repeatAt(jobSchedule)
        job.repeatEvery(jobRepeatEvery)
      } else if (jobSchedule) {
        job.schedule(jobSchedule)
      } else if (jobRepeatEvery) {
        job.repeatEvery(jobRepeatEvery)
      } else {
        return callback('Jobs not created')
      }
      job.save(function (err) {
        if (err) {
          return callback('Jobs not created')
        }
        callback()
      })
    } catch (e) {
      callback(e.message)
    }
  }

  function getOverview (callback) {
    agenda._collection.aggregate([
      {$project: {
        _id: 0,
        name: '$name',
        type: '$type',
        priority: '$priority',
        repeatInterval: '$repeatInterval',
        repeatTimezone: '$repeatTimezone',
        nextRunAt: {$ifNull: ['$nextRunAt', 0]},
        lockedAt: {$ifNull: ['$lockedAt', 0]},
        lastRunAt: {$ifNull: ['$lastRunAt', 0]},
        lastFinishedAt: {$ifNull: ['$lastFinishedAt', 0]},
        failedAt: {$ifNull: ['$failedAt', 0]}
      }},
      {$project: {
        name: '$name',
        type: '$type',
        priority: '$priority',
        repeatInterval: '$repeatInterval',
        repeatTimezone: '$repeatTimezone',
        running: {$cond: [{$and: [
          '$lastRunAt',
          {$gt: [ '$lastRunAt', '$lastFinishedAt' ]}
        ]}, 1, 0]},
        scheduled: {$cond: [{$and: [
          '$nextRunAt',
          {$gte: [ '$nextRunAt', new Date() ]}
        ]}, 1, 0]},
        queued: {$cond: [{$and: [
          '$nextRunAt',
          {$gte: [ new Date(), '$nextRunAt' ]},
          {$gte: [ '$nextRunAt', '$lastFinishedAt' ]}
        ]}, 1, 0]},
        completed: {$cond: [{$and: [
          '$lastFinishedAt',
          {$gt: ['$lastFinishedAt', '$failedAt']}
        ]}, 1, 0]},
        failed: {$cond: [{$and: [
          '$lastFinishedAt',
          '$failedAt',
          {$eq: ['$lastFinishedAt', '$failedAt']}
        ]}, 1, 0]},
        repeating: {$cond: [{$and: [
          '$repeatInterval',
          {$ne: ['$repeatInterval', null]}
        ]}, 1, 0]}
      }},
      {$group: {
        _id: '$name',
        displayName: {$first: '$name'},
        meta: {$addToSet: {
          type: '$type',
          priority: '$priority',
          repeatInterval: '$repeatInterval',
          repeatTimezone: '$repeatTimezone'
        }},
        total: {$sum: 1},
        running: {$sum: '$running'},
        scheduled: {$sum: '$scheduled'},
        queued: {$sum: '$queued'},
        completed: {$sum: '$completed'},
        failed: {$sum: '$failed'},
        repeating: {$sum: '$repeating'}
      }}
    ]).toArray(function (err, results) {
      if (err) return callback(err)
      var totals = {
        displayName: 'All Jobs'
      }
      var states = ['total', 'running', 'scheduled', 'queued', 'completed', 'failed', 'repeating']
      states.forEach(function (state) {
        totals[state] = 0
      })
      results.forEach(function (job) {
        states.forEach(function (state) {
          totals[state] += job[state]
        })
      })
      results.unshift(totals)
      callback(null, results)
    })
  }

  function getJobs(job, state, total, currentPage, itemsPerPage, callback) {
    var preMatch = {}
    if (job) preMatch.name = job

    var postMatch = {}
    if (state) postMatch[state] = true
    
    //Pagination
    var _itemsPerPage = ITEMS_PER_PAGE;
    var offset = 0;
    var totalPages = 1;

    if(itemsPerPage) {
      _itemsPerPage = parseInt(itemsPerPage);
    }
    currentPage = currentPage || CURRENT_PAGE;

    if(total) {
      totalPages = Math.ceil(total/_itemsPerPage)
    }

    if(currentPage <= totalPages) {
      offset = (currentPage - 1) * _itemsPerPage ;
    }
   
    var limit = _itemsPerPage
    var skip = offset 
    //Pagination ends

    agenda._collection.aggregate([
      {$match: preMatch},
      {$sort: {
        nextRunAt: -1,
        lastRunAt: -1,
        lastFinishedAt: -1
      }},
      {$project: {
        _id: 0,
        job: '$$ROOT',
        nextRunAt: {$ifNull: ['$nextRunAt', 0]},
        lockedAt: {$ifNull: ['$lockedAt', 0]},
        lastRunAt: {$ifNull: ['$lastRunAt', 0]},
        lastFinishedAt: {$ifNull: ['$lastFinishedAt', 0]},
        failedAt: {$ifNull: ['$failedAt', 0]},
        repeatInterval: {$ifNull: ['$repeatInterval', 0]}
      }},
      {$project: {
        job: '$job',
        _id: '$job._id',
        running: {$and: [
          '$lastRunAt',
          {$gt: [ '$lastRunAt', '$lastFinishedAt' ]}
        ]},
        scheduled: {$and: [
          '$nextRunAt',
          {$gte: [ '$nextRunAt', new Date() ]}
        ]},
        queued: {$and: [
          '$nextRunAt',
          {$gte: [ new Date(), '$nextRunAt' ]},
          {$gte: [ '$nextRunAt', '$lastFinishedAt' ]}
        ]},
        completed: {$and: [
          '$lastFinishedAt',
          {$gt: ['$lastFinishedAt', '$failedAt']}
        ]},
        failed: {$and: [
          '$lastFinishedAt',
          '$failedAt',
          {$eq: ['$lastFinishedAt', '$failedAt']}
        ]},
        repeating: {$and: [
          '$repeatInterval',
          {$ne: ['$repeatInterval', null]}
        ]}
      }},
      {$match: postMatch},
      {$skip: skip},
      {$limit: limit}      
    ]).toArray(function (err, results) {
      if (err) return callback(err)
      callback(null, results)
    })
  }

  //@Shan
  //Pagination
  function getTotalJobs (job, state, callback) {
    var preMatch = {}
    if (job) preMatch.name = job

    var postMatch = {}
    if (state) postMatch[state] = true

    agenda._collection.aggregate([
      {$match: preMatch},
      {$project: {
        job: '$job',
        _id: '$job._id',
        running: {$and: [
          '$lastRunAt',
          {$gt: [ '$lastRunAt', '$lastFinishedAt' ]}
        ]},
        scheduled: {$and: [
          '$nextRunAt',
          {$gte: [ '$nextRunAt', new Date() ]}
        ]},
        queued: {$and: [
          '$nextRunAt',
          {$gte: [ new Date(), '$nextRunAt' ]},
          {$gte: [ '$nextRunAt', '$lastFinishedAt' ]}
        ]},
        completed: {$and: [
          '$lastFinishedAt',
          {$gt: ['$lastFinishedAt', '$failedAt']}
        ]},
        failed: {$and: [
          '$lastFinishedAt',
          '$failedAt',
          {$eq: ['$lastFinishedAt', '$failedAt']}
        ]},
        repeating: {$and: [
          '$repeatInterval',
          {$ne: ['$repeatInterval', null]}
        ]}
      }},
      {$match: postMatch}
    ]).toArray(function (err, results) {
      if (err) return callback(err)
      callback(null, results.length)
    })
  }

}
