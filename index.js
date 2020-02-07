const { createWriteStream, writeFile, access, rename, F_OK } = require('fs')
const { join, resolve, basename, dirname } = require('path')
const { spawn } = require('child_process')
const ffmpegBin = require('ffmpeg-static')
const mkdirp = require('mkdirp')
const merge = require('lodash.merge')
const TwitchStream = require('get-twitch-stream')
const TwitchPubSub = require('twitch-realtime')
const chalk = require('chalk')
const stripAnsi = require('strip-ansi')
const minimist = require('minimist')(process.argv.slice(2))

const config_defaults = {
  streamer: 'Sweet_Anita',
  recorder: {
    stream_format: [
      'source'
    ],
    output_template: join('.', 'recordings', ':streamer -- :date, :time')
  },
  time: {
    timezone: 'Europe/London',
    timezone_format: 'en-GB'
  },
  developer: {
    log: 'debug.log',
    debug: false,
    verbose: false,
    simulate: false,
    dump_config: false
  }
}
let config_user = {}
try {
  config_user = require('./config')
} catch (error) {}
const config_args = {
  streamer: minimist.streamer,
  recorder: {
    stream_format: minimist.format ? minimist.format.split('/') : undefined,
    output_template: minimist.output_template
  },
  time: {
    timezone: minimist.tz,
    timezone_format: minimist.tz_format
  },
  developer: {
    log: minimist.log,
    debug: minimist.debug || minimist.verbose,
    verbose: minimist.verbose,
    simulate: minimist.simulate,
    dump_config: minimist.dump_config
  }
}
const config = merge(config_defaults, config_user, config_args)

if (minimist.help) {
  showHelp()
}
if (config.developer.debug) {
  if (!config.developer.dump_config) {
    config.developer.log = createWriteStream(resolve(config.developer.log), {
      flags: 'w'
    })
  }
  if (config.developer.verbose) {
    log(`${chalk.magentaBright('Verbose Debug Mode Enabled')}`)
  } else {
    log(`${chalk.magentaBright('Debug Mode Enabled')}`)
  }
}
if (config.developer.simulate) {
  log(`${chalk.magentaBright('Downloading Disabled')}`)
}
if (config.developer.dump_config) {
  log(`${chalk.magentaBright(`Dumping config to 'config_dump.json'`)}`)
  writeFile('config_dump.json', JSON.stringify(config, null, 2), {
    flags: 'w'
  }, err => {
    if (err) {
      return process.exit(1)
    }
    process.exit(0)
  })
}

function debug (msg) {
  let write = msg => {
    if (config.developer.debug && !config.developer.dump_config) {
      config.developer.log.write(msg)
    }
  }
  if (msg !== null) {
    if (config.developer.debug) {
      write(`[${new Date().toLocaleString(config.time.timezone_format)}] `)
      if (msg instanceof Buffer) {
        write(`${msg}`)
      } else if (msg instanceof Object) {
        write(`${JSON.stringify(msg, null, 2)}\n`)
      } else {
        write(`${stripAnsi(msg)}\n`)
      }
    }
  }
}
function log (msg) {
  if (msg !== null) {
    if (config.developer.debug) debug(msg)
    console.log(`${chalk.grey(`[${new Date().toLocaleString(config.time.timezone_format)}]`)}`, msg)
  }
}

const app = {
  stream: {
    live: false,
    recording: false,
    start: null
  },
  exiting: false
}
const twitchStream = new TwitchStream({
  channel: `${config.streamer}`
})

twitchStream.streamLive()
.then(isLive => {
  if (isLive) {
    log(`${config.streamer} is ${chalk.greenBright('live')}`)

    let time = new Date()
    let startTime = new Date(0)
    startTime.setUTCSeconds((time.getTime() + time.getTimezoneOffset() * 60 * 1000) / 1000)

    app.stream.live = true
    app.stream.start = startTime.toISOString()

    recordStream()
  } else {
    log(`${config.streamer} is ${chalk.redBright('offline')}`)
  }
})
.catch(err => debug)

const twitchPubSub = new TwitchPubSub({
  defaultTopics: [
    `video-playback.${config.streamer.toLowerCase()}`
  ],
  reconnect: true
})

twitchPubSub.on('connect', () => {
  debug(`Connected to Twitch PubSub`)
})
twitchPubSub.on('close', () => {
  debug(`Disconnected from Twitch PubSub`)
})
twitchPubSub.on('raw', data => {
  if (config.developer.verbose) debug(data)
})
twitchPubSub.on('stream-up', data => {
  if (!config.developer.verbose) debug(data)
  if (!app.stream.live) {
    log(`${config.streamer} is now ${chalk.greenBright('live')}`)

    let startTime = new Date(0)
    startTime.setUTCSeconds(data.time)

    app.stream.live = true
    app.stream.start = startTime.toISOString()

    recordStream()
  }
})
twitchPubSub.on('stream-down', data => {
  if (!config.developer.verbose) debug(data)
  if (app.stream.live) {
    log(`${config.streamer} is ${chalk.redBright('offline')}`)

    app.stream.live = false
    app.stream.start = null
  }
})

async function recordStream () {
  let filename = `${config.recorder.output_template}.mp4`

  let date_raw = new Date(`${app.stream.start}`)
  let timeZoneDate = date_raw.toLocaleString('en-GB', {
    timeZone: `${config.time.timezone}`,
  }).split(', ')
  let timeZoneTime = date_raw.toLocaleString(`${config.time.timezone_format}`, {
    timeZone: `${config.time.timezone}`,
  }).split(', ')
  let titleRaw = await twitchStream.getStreamTitle(config.streamer)

  let name = config.streamer.replace(/[/\\?%*:|"<>]/g, '-')
  let title = titleRaw.replace(/[/\\?%*:|"<>]/g, '-')
  let date = timeZoneDate[0].replace(/\//g, '.')
  let time = timeZoneTime[1].split(' ')[0].replace(/\:/g, '-')
  let day = timeZoneDate[0].split('/')[0]
  let month = timeZoneDate[0].split('/')[1]
  let year = timeZoneDate[0].split('/')[2]
  let shortYear = year.toString().substring(2)
  let period = timeZoneDate[1].split(':')[0] < 12 ? 'AM' : 'PM'

  filename = filename.toString().replace(/:streamer/gi, `${name}`)
  filename = filename.toString().replace(/:title/gi, `${title}`)
  filename = filename.toString().replace(/:date/gi, `${date}`)
  filename = filename.toString().replace(/:time/gi, `${time}`)
  filename = filename.toString().replace(/:day/gi, `${day}`)
  filename = filename.toString().replace(/:month/gi, `${month}`)
  filename = filename.toString().replace(/:year/gi, `${year}`)
  filename = filename.toString().replace(/:shortYear/gi, `${shortYear}`)
  filename = filename.toString().replace(/:period/gi, `${period}`)
  filename = filename.replace(/[/?%*:|"<>]/g, '-')

  mkdirp(dirname(resolve(filename)))

  filename = await reserveFile({ basefile: filename })

  new Promise(async (p_resolve, p_reject) => {
    let streamUrl = await twitchStream.getStreamURL(config.recorder.format)

    debug(`stream url: ${streamUrl}`)
    debug(`downloading stream to: ${resolve(filename)}`)

    let ffmpeg_args = [
      '-hide_banner',
      '-loglevel', 'quiet',
      '-n',
      /*
        this flag is not reccomended for live stream inputs but can be used to get around bug https://trac.ffmpeg.org/ticket/7369,
        uncomment if streams stop downloading before streamer offline
        '-re',
      */
      '-i', `${streamUrl}`,
      '-c', 'copy',
      '-f', 'mp4',
      `${resolve(filename)}`,
    ]
    let ffmpeg_args_simulated = [
      '-hide_banner',
      '-loglevel', 'quiet',
      '-n',
      '-i', `${streamUrl}`,
      '-c', 'copy',
      '-f', 'null',
      '-',
    ]
    let ffmpeg = spawn(ffmpegBin, (config.developer.simulate ? ffmpeg_args_simulated : ffmpeg_args), {
      cwd: process.cwd()
    })

    function abort () {
      app.exiting = true
      try {
        ffmpeg.stdin.setEncoding('utf-8')
        ffmpeg.stdin.write('q\n')
      } catch (error) {}
      setTimeout(() => {
        process.exit(0)
      }, 2000)
    }

    process.on('SIGINT', abort)
    process.on('SIGHUP', abort)

    ffmpeg.on('close', code => {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGHUP', abort)

      return p_resolve(code)
    })

    ffmpeg.on('error', error => {
      return p_reject(error)
    })

    if (ffmpeg.pid) {
      log(`${chalk.cyanBright(`• `)}${chalk.reset(`Recording '${config.streamer}' live stream to file`)}`)

      app.stream.recording = true
    }
  })
  .then(code => {
    app.stream.recording = false

    if (config.developer.verbose)  debug(`ffmpeg exited with code ${code}`)
    if (code === 0) {
      if (!app.exiting) {
        log(`${chalk.greenBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream completed`)}`)
      } else if (app.stream.live && app.exiting) {
        log(`${chalk.yellowBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream aborted; a partial stream may have been saved`)}`)
      }
    } else {
      if (app.stream.live && !app.exiting) {
        log(`${chalk.redBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream error; a partial stream may have been saved`)}`)
      } else if (app.stream.live && app.exiting) {
        log(`${chalk.yellowBright(`• `)}${chalk.reset(`Recording of '${config.streamer}' live stream aborted; a partial stream may have been saved`)}`)
      }
    }
  })
  .catch(err => {
    log(`${chalk.redBright(`• `)}${chalk.reset(`Unable to start recording '${config.streamer}' live stream`)}`)
    debug(`failed to start subprocess: ${err.message}`)

    process.exit(1) // abort because something has gone wrong with spawn
  })
}

function reserveFile (options) {
  let basefile = options.basefile
  let checkfile = options.checkfile !== undefined? options.checkfile : options.basefile
  let parts = options.parts !== undefined ? options.parts : 0

  return new Promise((p_resolve, p_reject) => {
    if (parts === 0) {
      access(resolve(`${join(dirname(basefile), basename(basefile, `.mp4`))} (part 1).mp4`), F_OK, err => {
        if (!err) { // file exist
          parts++
          return p_resolve({
            basefile: basefile,
            checkfile: `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`,
            parts: parts
          })
        } else { // file not exist
          access(resolve(checkfile), F_OK, err => {
            if (!err) { // file exist, rename
              parts++
              let newfile = `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`
              rename(resolve(basefile), resolve(newfile), err => {
                if (!err) debug(`renamed ${basefile} -> ${newfile}`)
              })
              parts++
              return p_resolve({
                basefile: basefile,
                checkfile: `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`,
                parts: parts
              })
            } else { // file not exist, this must be first part
              return p_resolve(checkfile)
            }
          })
        }
      })
    } else {
      access(resolve(checkfile), F_OK, err => {
        if (!err) { // file exist
          parts++
          return p_resolve({
            basefile: basefile,
            checkfile: `${join(dirname(basefile), basename(basefile, `.mp4`))} (part ${parts}).mp4`,
            parts: parts
          })
        } else { // file not exist
          return p_resolve(checkfile)
        }
      })
    }
  })
  .then(data => {
    if (data instanceof Object) {
      return reserveFile(data)
    } else {
      return data
    }
  })
}

function showHelp () {
  console.log(`
    ${chalk.magentaBright(`Twitch Stream Recorder`)}  -  Monitor Twitch Streamer and Record Live Stream to disk automatically.
    ------------------------------------------------------------------------------------------------
    ${chalk.grey(`Created by Bradley 'Bred/cmd430' Treweek`)}


      Usage: node index ${chalk.grey(`[options] [dev options]`)}

        Options:
          --streamer=${chalk.grey(`<streamer username>`)}    Set the Twitch streamer to monitor
                                            Default: ${chalk.grey(`sweet_anita`)}

          --output_template=${chalk.grey(`"<template>"`)}    Set template and path for recorded streams, if path does not exit it will be created
                                            Accepts tokens; :streamer, :title, :date, :time, :day, :month, :year, :shortYear, :period
                                            Default: ${chalk.grey(`./recordings/:date, :time -- :streamer`)}

          --format=${chalk.grey(`<format>`)}                 Set the stream record quality
                                            Accepts list of qualities in order of preference seperated by / e.g ${chalk.grey(`1080p60/1080p/720p60/720p`)}
                                            Default: ${chalk.grey(`source`)}

          --tz=${chalk.grey(`<timezone>`)}                   Set the timezone used when dating saved streams
                                            Default: ${chalk.grey(`Europe/London`)}

          --tz_format=${chalk.grey(`<timezone format>`)}     Set the timezone for local logs and file names, accepts en-GB or en-US
                                            Default: ${chalk.grey(`en-GB`)}

          --help                            Show this help

        Dev Options:
          --debug                           Log data to debug.log file
          --verbose                         adds logging for all Twitch api events, this can lead to a very large log file, --debug is implied
          --simulate                        Disable writing to disk (do not keep downloaded stream)
          --dump_config                     Dump config as seen by the application to 'config.dump' then exit
  `)
  process.exit(0)
}
