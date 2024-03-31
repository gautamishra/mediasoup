// Http socket server 
import express from 'express'
import https from 'httpolyglot'
import fs from 'fs'
import path from 'path'
import {Server} from 'socket.io'

// mediosuoup imprt 
import mediasoup from 'mediasoup'
 
const app = express()

const __dirname = path.resolve()

console.log(__dirname)

//static expose of a direcotry 
app.use('/sfu', express.static(path.join(__dirname, 'public')))

app.get('/', (req, res) => {
    res.send("Hello from express server")
})

// create Ssl options for https server 
const options = {
    key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
    cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8'),
    passphrase: 'gautam'
}
 
// https enable
const httpsServer = https.createServer(options, app)

// listen to a port
httpsServer.listen(3000, () => {
    console.log('Listening on port: ' + 3000)
})

// create socket io  server 

const io = new Server(httpsServer)

const peers = io.of('mediasoup')


/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer 
 **/



// create worker for Media Soup One Worker use one CPU core 
// router kind of represent a room 
let worker
let router
let producerTransport
let consumerTransport
let producer
let consumer


// define meia codesc for router

// This is an Array of RtpCapabilities
// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// list of media codecs supported by mediasoup ...
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
const mediaCodecs = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
  ]


const createWorker =  async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 2020,
    })

    console.log(`worker process id ${worker.pid}`)

    worker.on('died', (error) => {
        console.log(error.message)
    })
}

worker = createWorker()

peers.on('connection', async socket => {
    console.log(socket.id)
    socket.emit('connection-success', {
      socketId : socket.id,
      existsProducers: producer ? true : false
    })

    socket.on('disconnect', () => {
        // do some cleanup
        console.log('peer disconnected')
      })

    socket.on('createRoom', async (callback) => {

          // worker.createRouter(options)
    // options = { mediaCodecs, appData }
    // mediaCodecs -> defined above
    // appData -> custom application data - we are not supplying any
    // none of the two are required

      if(router === undefined) {
        router = await worker.createRouter({ mediaCodecs, })
        console.log(`Router Id : ${router.id}`)
      }
        getRtpCapabilities(callback)
    })

    const getRtpCapabilities = (callback) =>  {

        const rtpCapabilities = router.rtpCapabilities

        console.log('rtp Capabilities', rtpCapabilities)

        // call callback from the client and send back the rtpCapabilities
        callback({ rtpCapabilities })
         
    }


     socket.on('createWebRtcTransport', async ({ sender }, callback) => {
        console.log(`Is this a Sender Request? ${sender}`)

        if(sender)
            producerTransport = await createWebRtcTransportRequest(callback);
        else 
            consumerTransport = await createWebRtcTransportRequest(callback);

     })

      // see client's socket.emit('transport-connect', ...)
  socket.on('transport-connect', async ({ dtlsParameters }) => {
    console.log('DTLS PARAMS... ', { dtlsParameters })
    await producerTransport.connect({ dtlsParameters })
  })

  // see client's socket.emit('transport-produce', ...)
  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    // call produce based on the prameters from the client
    producer = await producerTransport.produce({
      kind,
      rtpParameters,
    })

    console.log('Producer ID: ', producer.id, producer.kind)

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })

    // Send back to the client the Producer's id
    callback({
      id: producer.id
    })
  })

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on('transport-recv-connect', async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`)
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      // check if the router can consume the specified producer
      if (router.canConsume({
        producerId: producer.id,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
        })

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })

  socket.on('consumer-resume', async () => {
    console.log('consumer resume')
    await consumer.resume()
  })
})


const createWebRtcTransportRequest = async (callback) => {
    try {
        const webRtcTransport_options = {
            listenIps: [
              {   ip: '0.0.0.0', // replace with relevant IP address
              announcedIp: '127.0.0.1',
              }
            ],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        }

          // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
        let transport = await router.createWebRtcTransport(webRtcTransport_options)
        console.log(`transport id: ${transport.id}`)

        transport.on('dtlsstatechange', dtlsState => {
            if(dtlsState == 'close') {
                transport.close()
            }
        })

        transport.on('close', () => {
            console.log('transport close')
        })

        callback({
             // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        })

        return transport

    } catch (error) {
        console.log(error)
        callback({
            params: {
                error: error
            }
        })
    }
}


