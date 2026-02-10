import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, GeoPoint } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';

import * as functions from 'firebase-functions';

import { onRequest } from 'firebase-functions/v2/https';
// import { onUserCreated } from 'firebase-functions/v2/identity';
import { onDocumentUpdated, onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import fetch from 'node-fetch';
import { pipeline } from 'stream/promises';
import path from 'path';
import csv from 'csv-parser';
import fs from 'fs-extra';
import os from 'os';
import crypto from 'crypto';
import * as geofire from 'geofire-common';
import pLimit from 'p-limit';

const app = initializeApp();
const db = getFirestore(app);
const messaging = getMessaging(app);
const storage = getStorage(app);
const bucket = storage.bucket();

/*********************************************************
 * User Document Creation on Auth Signup
 *********************************************************/
export const createUserDoc = functions.auth.user().onCreate((user) => {
  const { uid, email, displayName, photoURL } = user;

  return db.collection('users').doc(uid).set({
    email,
    displayName,
    photoURL,
    createdAt: FieldValue.serverTimestamp(),
  });
});

/*********************************************************
 * PubSub: Weather Check
 *********************************************************/
export const checkWeatherStatusPubSub = onSchedule(
  {
    schedule: 'every 1 minutes',
    region: 'us-east4',
    nodeVersion: '20',
  },
  async () => {
    await checkWeatherStatus();
    return null;
  },
);

const START_HOUR = 7;
const END_HOUR = 22;

const getNextSendTime = (now) => {
  const sendTime = new Date(now);
  const hour = sendTime.getHours();

  if (hour >= START_HOUR && hour <= END_HOUR) {
    sendTime.setMinutes(sendTime.getMinutes() + 5);
    return sendTime;
  }

  if (hour >= END_HOUR) {
    sendTime.setDate(sendTime.getDate() + 1);
  }

  sendTime.setHours(START_HOUR, 5, 0, 0);
  return sendTime;
};

export const schedulePushNotifications = async (db, params) => {
  if (!params.tokens || params.tokens.length === 0) return;

  const now = new Date();
  const sendAtDate = getNextSendTime(now);

  await db.collection('scheduledNotifications').add({
    tokens: params.tokens,
    title: params.title,
    body: params.body,
    sendAt: Timestamp.fromDate(sendAtDate),
    status: 'pending',
    createdAt: Timestamp.fromDate(now),
  });
};

/*****************************************************************
 * Send scheduled notifications
 ****************************************************************/
export const sendScheduledNotifications = onSchedule(
  {
    schedule: 'every 1 minutes',
    region: 'us-east4',
    nodeVersion: '20',
  },
  async () => {
    console.log('[sendScheduledNotifications] Setting up tasks...');

    const now = Timestamp.now();

    const snapshot = await db.collection('scheduledNotifications').where('status', '==', 'pending').where('sendAt', '<=', now).limit(100).get();

    if (snapshot.empty) {
      console.log('[sendScheduledNotifications] No pending notifications found.');
      return;
    }

    for (const doc of snapshot.docs) {
      const data = doc.data();

      try {
        const response = await messaging.sendEachForMulticast({
          tokens: data.tokens,
          notification: {
            title: data.title,
            body: data.body,
          },
          android: { priority: 'high' },
        });

        await doc.ref.update({
          status: 'sent',
          sentAt: Timestamp.now(),
        });
      } catch (e) {
        await doc.ref.update({
          status: 'failed',
          error: e.message,
        });
      }
    }

    console.log('[sendScheduledNotifications] Completed.');
  },
);

/*********************************************************
 * Archive Old Pending Jobs
 *********************************************************/
export const archiveOldPendingJobs = onSchedule(
  {
    schedule: '0 0 * * *',
    timeZone: 'America/New_York',
    region: 'us-east4',
    nodeVersion: '20',
  },
  async () => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const snapshot = await db.collection('inletCleaningJobs').where('status', '==', 'pending').where('createdAt', '<', Timestamp.fromDate(twoWeeksAgo)).get();

    if (snapshot.empty) {
      console.log('No old pending cleaning jobs found.');
      return null;
    }

    const batch = db.batch();
    snapshot.docs.forEach((docSnap) => {
      batch.update(docSnap.ref, {
        status: 'archived',
        archivedAt: FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    console.log(`Archived ${snapshot.size} pending jobs older than 2 weeks.`);
    return null;
  },
);

/*********************************************************
 * Manual Weather Trigger
 *********************************************************/
export const triggerWeatherStatus = onRequest(
  {
    region: 'us-east4',
    nodeVersion: '20',
  },
  async (req, res) => {
    await checkWeatherStatus();
    res.send('Triggered');
  },
);

export const testAdminNotification = onRequest(
  {
    region: 'us-east4',
    nodeVersion: '20',
  },
  async (req, res) => {
    const userDocs = await db.collection('users').where('role', '==', 'admin').get();

    if (!userDocs.empty) {
      for (const userDoc of userDocs.docs) {
        const user = userDoc.data();
        if (user.tokens) {
          const message = {
            tokens: user.tokens,
            notification: {
              title: 'Test Admin Notification',
              body: 'This is a test admin notification.',
            },
            android: { priority: 'high' },
          };

          const response = await messaging.sendEachForMulticast(message);

          response.responses.forEach((r, i) => {
            if (r.success) console.log(`Message to ${user.tokens[i]} succeeded`);
            else console.error(`Message failed: ${r.error?.message}`);
          });
        }
      }
    } else {
      console.log('No admins found.');
    }

    res.status(200).send('Test complete');
  },
);

/*********************************************************
 * Cleaning Job Status Updated
 *********************************************************/
export const cleaningJobStatusUpdatedV2 = onDocumentUpdated(
  {
    document: 'inletCleaningJobs/{inletCleaningJobId}',
    region: 'us-east4',
    nodeVersion: '20',
  },
  async (event) => {
    const newValue = event.data.after.data();
    const oldValue = event.data.before.data();

    let tokens = [];

    if (newValue.status === 'completed') {
      const userDocs = await db.collection('users').where('role', '==', 'admin').get();

      if (!userDocs.empty) {
        for (const userDoc of userDocs.docs) {
          const user = userDoc.data();
          if (user.tokens) {
            tokens.push(...user.tokens);
          }
        }

        if (tokens.length > 0) {
          const message = {
            tokens,
            notification: {
              title: 'A cleaning job has been completed',
              body: 'A recent cleaning job has been completed by a volunteer. Please review in admin panel.',
            },
            android: { priority: 'high' },
          };

          const response = await messaging.sendEachForMulticast(message);

          response.responses.forEach((r, i) => {
            if (r.success) console.log(`Message to ${tokens[i]} succeeded`);
            else console.error(`Message failed: ${r.error?.message}`);
          });
        }
      }
    }
  },
);

/*********************************************************
 * Firestore Listener: Inlet Status Updated
 *********************************************************/
export const inletStatusUpdatedV2 = onDocumentUpdated(
  {
    document: 'inlets/{inletId}',
    region: 'us-east4',
    nodeVersion: '20',
  },
  async (event) => {
    const newValue = event.data.after.data();
    const oldValue = event.data.before.data();

    if (!newValue || !oldValue) return;

    const lastNotification = newValue.lastNotificationAndCleaningJobCreated;
    const now = Timestamp.now();

    const riskIncreased = oldValue.risk !== newValue.risk && newValue.risk > 35;
    const heavyRainExpected = newValue.heavyRainExpected === true;
    const enoughTimePassed = !lastNotification || now.toMillis() - lastNotification.toMillis() >= 48 * 60 * 60 * 1000;

    if (!heavyRainExpected) {
      console.log(`[Inlet ${event.params.inletId}] Risk changed but rainfall below threshold (${newValue.rainNext48Inches} in.) `);
      return;
    }

    if (!riskIncreased || !enoughTimePassed) return;

    console.log(`[Inlet ${event.params.inletId}] High risk + Heavy rain detected, creating cleaning job...`);

    await createInletCleaningJob(event.params.inletId, newValue.risk);

    let tokens = [];

    for (const userId of newValue.subscribed ?? []) {
      const userDoc = await db.collection('users').doc(userId).get();
      if (userDoc.exists && userDoc.data().tokens) {
        tokens.push(...userDoc.data().tokens);
      }
    }

    await schedulePushNotification(db, {
      tokens,
      title: 'Inlet Cleaning Needed',
      body: oldValue?.address ? `The Inlet at ${oldValue.address} needs cleaning.` : 'An Inlet you follow requires cleaning.',
    });

    await db.collection('inlets').doc(event.params.inletId).update({ lastNotificationAndCleaningJobCreated: now });

    // if (!lastNotification || now.toDate().getTime() - lastNotification.toDate().getTime() >= 48 * 60 * 60 * 1000) {
    //   if (oldValue.risk !== newValue.risk && newValue.risk > 35) {
    //     console.log('High risk detected, creating cleaning job...');
    //     await createInletCleaningJob(event.params.inletId, newValue.risk);

    //     let tokens = [];

    //     for (const userId of newValue.subscribed ?? []) {
    //       const userDoc = await db.collection('users').doc(userId).get();
    //       if (userDoc.exists && userDoc.data().tokens) {
    //         tokens.push(...userDoc.data().tokens);
    //       }
    //     }

    //     await schedulePushNotification(db, {
    //       tokens,
    //       title: 'Inlet Cleaning Needed',
    //       body: oldValue?.address ? `The Inlet at ${oldValue.address} needs cleaning.` : 'An Inlet you follow requires cleaning.',
    //     });

    //     if (tokens.length > 0) {
    //       const message = {
    //         tokens,
    //         notification: {
    //           title: 'Inlet Cleaning Needed',
    //           body: oldValue?.address ? `The Inlet at ${oldValue.address} needs cleaning.` : 'An Inlet you follow requires cleaning.',
    //         },
    //         android: { priority: 'high' },
    //       };

    //       const response = await messaging.sendEachForMulticast(message);
    //       response.responses.forEach((r, i) => {
    //         if (r.success) console.log(`Message to ${tokens[i]} succeeded`);
    //         else console.error(`Message failed: ${r.error?.message}`);
    //       });
    //     }

    //     await db.collection('inlets').doc(event.params.inletId).update({ lastNotificationAndCleaningJobCreated: now });
    //   }
    // }
  },
);

/*********************************************************
 * Storage Trigger: CSV Imports
 *********************************************************/
export const checkUploadedImageV2 = onObjectFinalized(
  {
    region: 'us-east4',
    nodeVersion: '20',
  },
  async (event) => {
    const { bucket: bucketName, name: filePath, contentType } = event.data;

    const fileDir = path.dirname(filePath);
    if (fileDir !== 'inlet-uploads' || !['text/csv', 'application/vnd.ms-excel'].includes(contentType)) {
      console.log('Skipping non-CSV or invalid upload.');
      return null;
    }

    const results = [];
    const bucketRef = getStorage().bucket(bucketName);
    const tempFilePath = path.join(os.tmpdir(), path.basename(filePath));

    await fs.ensureDir(path.dirname(tempFilePath));
    await bucketRef.file(filePath).download({ destination: tempFilePath });

    return new Promise((resolve) => {
      fs.createReadStream(tempFilePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
          for (const row of results) {
            const hash = geofire.geohashForLocation([parseFloat(row.latitude), parseFloat(row.longitude)]);

            await db
              .collection('inlets')
              .doc(hash)
              .set(
                {
                  geoHash: hash,
                  geoLocation: new GeoPoint(parseFloat(row.latitude), parseFloat(row.longitude)),
                  address: row.address,
                  description: row.description,
                  images: row.images,
                  instructions: row.instructions,
                },
                { merge: true },
              );
          }
          resolve(null);
        });
    });
  },
);

/*********************************************************
 * Test Push Notifications
 *********************************************************/
export const testPushNotifications = onRequest(
  {
    region: 'us-east4',
    nodeVersion: '20',
  },
  async (req, res) => {
    try {
      const userId = req.query.user;
      const userDoc = await db.collection('users').doc(userId).get();

      const tokens = userDoc.data()?.tokens ?? [];
      if (tokens.length === 0) {
        return res.status(200).send('No push tokens for user.');
      }

      const message = {
        tokens,
        notification: {
          title: 'Cleanlet Test',
          body: 'If you are receiving this message, this is a test.',
        },
        android: { priority: 'high' },
      };

      const response = await messaging.sendEachForMulticast(message);
      console.log('FCM Response:', JSON.stringify(response, null, 2));

      res.status(200).send('Test complete');
    } catch (error) {
      console.error(error);
      res.status(500).send('Internal Server Error');
    }
  },
);

/*********************************************************
 * Manually Trigger Cleaning Job Notifications
 *********************************************************/
export const manuallyTriggerCleaningJobNotifications = onRequest(
  {
    region: 'us-east4',
    nodeVersion: '20',
  },
  async (_req, res) => {
    try {
      const now = Timestamp.now().toDate();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      const jobsSnapshot = await db.collection('inletCleaningJobs').where('createdAt', '>=', Timestamp.fromDate(startOfDay)).where('createdAt', '<=', Timestamp.fromDate(endOfDay)).get();

      if (jobsSnapshot.empty) {
        res.status(200).send('No jobs created today.');
        return;
      }

      const processedInlets = new Set();
      let totalSent = 0;
      let totalFailed = 0;

      for (const jobDoc of jobsSnapshot.docs) {
        const job = jobDoc.data();
        const inletId = job.inletId;

        if (processedInlets.has(inletId)) continue;
        processedInlets.add(inletId);

        const inletDoc = await db.collection('inlets').doc(inletId).get();
        if (!inletDoc.exists) continue;

        const inlet = inletDoc.data();
        const subscribed = inlet.subscribed ?? [];

        let tokens = [];
        for (const userId of subscribed) {
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            tokens.push(...(userDoc.data().tokens ?? []));
          }
        }

        for (const token of tokens) {
          try {
            await messaging.send({
              token,
              notification: {
                title: 'Inlet Cleaning Needed',
                body: 'An Inlet you follow needs cleaning.',
              },
              android: { priority: 'high' },
            });
            totalSent++;
          } catch (e) {
            totalFailed++;
          }
        }
      }

      res.status(200).send(`Sent: ${totalSent}, Failed: ${totalFailed}`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal Server Error');
    }
  },
);

/*********************************************************
 * Utility: Create Inlet Cleaning Job
 *********************************************************/
async function createInletCleaningJob(inletId, risk) {
  const ref = await db.collection('inletCleaningJobs').add({
    inletId,
    createdAt: FieldValue.serverTimestamp(),
    status: 'pending',
    risk,
  });
  await db.collection('inlets').doc(inletId).update({
    jobId: ref.id,
    status: 'cleaningScheduled',
  });
}

export const MM_PER_INCH = 25.4;
export const RAIN_THRESHOLD_MM = 0.75 * MM_PER_INCH;

const parseValidTime = (validTime) => {
  const [startStr, durationStr] = validTime.split('/');

  const start = new Date(startStr);

  const hours = Number(durationStr.replace('PT', '').replace('H', ''));
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);

  return { start, end };
};

export const sumPrecipitationMM = (values, windowStart, windowEnd) => {
  let total = 0;

  for (const entry of values) {
    if (entry.value == null) continue;

    const { start, end } = parseValidTime(entry.validTime);

    const overlaps = start < windowEnd && end > windowStart;

    if (overlaps) {
      total += entry.value;
    }
  }

  return total;
};

/*********************************************************
 * Weather Check Function
 *********************************************************/
async function checkWeatherStatus() {
  console.log('Checking weather status...');
  const inlets = await db.collection('inlets').get();

  const now = new Date();
  const window24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const window48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  for (const doc of inlets.docs) {
    const inlet = doc.data();
    const { latitude, longitude } = inlet.geoLocation;

    const pointRes = await fetch(`https://api.weather.gov/points/${latitude},${longitude}`);
    const pointJson = await pointRes.json();
    const forecastUrl = pointJson.properties.forecast;
    const gridPointUrl = pointJson.properties.forecastGridData;

    const forecastRes = await fetch(forecastUrl);
    const forecastJson = await forecastRes.json();
    const periods = forecastJson.properties.periods;
    const nextPeriod = periods[0];
    const risk = nextPeriod.probabilityOfPrecipitation?.value || 0;

    const gridPontRes = await fetch(gridPointUrl);
    const gridPointJson = await gridPontRes.json();

    const quantitativePrecipitation = gridPointJson.properties.quantitativePrecipitation;

    let rain24to48MM = 0;
    let rainNext48MM = 0;

    if (quantitativePrecipitation?.values?.length) {
      rainNext48MM = sumPrecipitationMM(quantitativePrecipitation.values, now, window48h);

      rain24to48MM = sumPrecipitationMM(quantitativePrecipitation.values, window24h, window48h);
    }

    const rainNext48Inches = rainNext48MM / MM_PER_INCH;
    const heavyRainExpected = rainNext48MM >= RAIN_THRESHOLD_MM;

    await doc.ref.update({
      risk,
      rainNext48Inches: Number(rainNext48Inches.toFixed(2)),
      heavyRainExpected,
      weatherCheckedAt: FieldValue.serverTimestamp(),
    });

    if (inlet.inletStatus === 'ready') {
      await db.collection('weatherPredictions').add({
        inletId: doc.id,
        risk,
        rainNext48Inches: Number(rainNext48Inches.toFixed(2)),
        heavyRainExpected,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }
}

/*********************************************************
 * Process Imports
 *********************************************************/
// export const processImports = onDocumentCreated(
//   {
//     document: 'importQueue/{docId}',
//     region: 'us-east4',
//     nodeVersion: '20',
//   },
//   async (event) => {
//     const snap = event.data;

//     if (!snap) {
//       console.log('No snapshot found.');
//       return;
//     }

//     const data = snap.data();

//     if (!data?.rows || !Array.isArray(data.rows)) {
//       console.log('Invalid row payload.');
//       await snap.ref.delete();
//       return;
//     }

//     const inletRef = db.collection('inlets');

//     const rows = data.rows;

//     for (let i = 0; i < rows.length; i += 500) {
//       const batch = db.batch();
//       const slice = rows.slice(i, i + 500);

//       slice.forEach(async (row) => {
//         if (!row.name || !row.latitude || !row.longitude) return;

//         const docRef = inletRef.doc();

//         batch.set(docRef, {
//           nickName: row.name,
//           address: row.address || '',
//           description: row.description || '',
//           geoLocation: new GeoPoint(Number(row.latitude), Number(row.longitude)),
//           inletStatus: row.inletStatus ?? 'photo_needed',
//         });
//       });

//       await batch.commit();
//     }

//     await snap.ref.delete();
//   }
// );

const normalizeGeo = (lat, lng) => {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
};

export const manualNormalizeGeo = onRequest(
  {
    region: 'us-east4',
    nodeVersion: '20',
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (_, res) => {
    const PAGE_SIZE = 500;
    let lastDoc = null;
    let totalUpdated = 0;

    while (true) {
      let query = db.collection('inlets').orderBy('__name__').limit(PAGE_SIZE);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snap = await query.get();

      console.log(`Updating ${snap.size} documents...`);

      if (snap.empty) break;

      const batch = db.batch();
      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.geoHash) continue;

        const geo = data.geoLocation;
        if (!geo || geo.latitude == null || geo.longitude == null) {
          console.warn(`Skipping ${doc.id} due to missing geolocation.`);
          continue;
        }

        const geoHash = normalizeGeo(geo.latitude, geo.longitude);

        batch.update(doc.ref, {
          geoHash,
        });

        totalUpdated++;
      }
      await batch.commit();
      lastDoc = snap.docs[snap.docs.length - 1];
    }

    res.json({
      success: true,
      updated: totalUpdated,
    });
  },
);

async function fetchImageWithRedirects(url, maxRedirects = 5) {
  let currentUrl = url;

  for (let i = 0; i < maxRedirects; i++) {
    const response = await fetch(currentUrl, {
      redirect: 'manual',
    });

    // Success
    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    // Redirect
    if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Redirect without Location header');
      }

      currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).toString();

      continue;
    }

    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  throw new Error('Too many redirects');
}

const processImport = async (snap) => {
  const data = snap.data();

  if (!data?.rows || !Array.isArray(data.rows)) {
    console.log('Invalid row payload.');
    await snap.ref.delete();
    return;
  }

  const inletRef = db.collection('inlets');
  const rows = data.rows;

  for (let i = 0; i < rows.length; i += 500) {
    const batch = db.batch();
    const slice = rows.slice(i, i + 500);

    for (const row of slice) {
      if (!row.name || !row.latitude || !row.longitude) return;

      const imageFiles = [];

      if (row.image) {
        try {
          console.log(`Fetching image: ${row.image}`);
          const response = await fetchImageWithRedirects(row.image);

          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${row.image}`);
          }

          const contentType = response.headers.get('content-type') || 'image/jpeg';

          if (!contentType.startsWith('image/')) {
            throw new Error(`URL is not an image`);
          }

          // const buffer = Buffer.from(await response.arrayBuffer());

          const ext = contentType.split('/')[1]?.split(';')[0] || 'jpeg';

          const filename = `${crypto.randomUUID()}.${ext}`;
          const objectKey = `inlet-photos/${filename}`;

          const file = bucket.file(objectKey);

          const writeStream = file.createWriteStream({
            resumable: false,
            metadata: {
              contentType,
              cacheControl: 'public, max-age=31536000',
            },
          });

          await pipeline(response.body, writeStream);

          await file.makePublic();

          imageFiles.push(filename);
        } catch (e) {
          console.error('Image upload failed:', e);
        }
      }

      // Dedup Logic
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      const geohash = normalizeGeo(lat, lng);

      const existingSnap = await inletRef
        .where('nickName', '==', row.name)
        .where('description', '==', row.description || '')
        .where('geoHash', '==', geohash)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        const doc = existingSnap.docs[0];
        const existingData = doc.data();

        const updatedImages = Array.from(new Set([...(existingData.images || []), ...imageFiles]));

        const finalAddress = (existingData.address && existingData.address.trim()) || (row.address && row.address.trim()) || '';

        const isReady = updatedImages.length > 0 && finalAddress.length > 0;

        const updatePayload = {
          images: updatedImages,
        };

        if (!existingData.address && finalAddress) {
          updatePayload.address = finalAddress;
        }

        if (isReady && existingData.inletStatus !== 'ready') {
          updatePayload.inletStatus = 'ready';
        }

        batch.update(doc.ref, updatePayload);
      } else {
        const docRef = inletRef.doc();

        batch.set(docRef, {
          nickName: row.name,
          address: row.address || '',
          description: row.description || '',
          images: imageFiles,
          geoLocation: new GeoPoint(Number(row.latitude), Number(row.longitude)),
          geoHash: geohash,
          inletStatus: row?.address.trim() && imageFiles.length > 0 ? 'ready' : 'photo_needed',
        });
      }
    }

    await batch.commit();
  }

  await snap.ref.delete();
};

export const reprocessImports = onRequest(
  {
    region: 'us-east4',
    nodeVersion: '20',
    memory: '2GiB',
    timeoutSeconds: 540,
  },
  async (req, res) => {
    const { docId } = req.query.docId;

    let query = db.collection('importQueue');

    if (docId) {
      const snap = await query.doc(docId).get();
      if (!snap.exists) {
        res.status(404).json({ error: 'job not found' });
        return;
      }

      await processImport(snap);
      res.json({ success: true, processed: docId });
      return;
    }

    const snaps = await query.get();
    let processed = 0;

    for (const snap of snaps.docs) {
      await processImport(snap);
      processed++;
    }

    res.json({ success: true, processed });
  },
);

export const processImports = onDocumentCreated(
  {
    document: 'importQueue/{docId}',
    region: 'us-east4',
    nodeVersion: '20',
    memory: '2GiB', // TEMP
    timeoutSeconds: 540, // TEMP
  },
  async (event) => {
    const snap = event.data;

    if (!snap) {
      console.log('No snapshot found.');
      return;
    }

    const data = snap.data();

    if (!data?.rows || !Array.isArray(data.rows)) {
      console.log('Invalid row payload.');
      await snap.ref.delete();
      return;
    }

    const inletRef = db.collection('inlets');
    const rows = data.rows;

    for (let i = 0; i < rows.length; i += 500) {
      const batch = db.batch();
      const slice = rows.slice(i, i + 500);

      for (const row of slice) {
        if (!row.name || !row.latitude || !row.longitude) return;

        const imageFiles = [];

        if (row.image) {
          try {
            console.log(`Fetching image: ${row.image}`);
            const response = await fetchImageWithRedirects(row.image);

            if (!response.ok) {
              throw new Error(`Failed to fetch image: ${row.image}`);
            }

            const contentType = response.headers.get('content-type') || 'image/jpeg';

            if (!contentType.startsWith('image/')) {
              throw new Error(`URL is not an image`);
            }

            // const buffer = Buffer.from(await response.arrayBuffer());

            const ext = contentType.split('/')[1]?.split(';')[0] || 'jpeg';

            const filename = `${crypto.randomUUID()}.${ext}`;
            const objectKey = `inlet-photos/${filename}`;

            const file = bucket.file(objectKey);

            const writeStream = file.createWriteStream({
              resumable: false,
              metadata: {
                contentType,
                cacheControl: 'public, max-age=31536000',
              },
            });

            await pipeline(response.body, writeStream);

            // await file.save(buffer, {
            //   metadata: {
            //     contentType,
            //     cacheControl: 'public, max-age=31536000',
            //   },
            //   resumable: false,
            // });

            await file.makePublic();

            imageFiles.push(filename);
          } catch (e) {
            console.error('Image upload failed:', e);
          }
        }

        // Dedup Logic
        const lat = Number(row.latitude);
        const lng = Number(row.longitude);
        const geohash = normalizeGeo(lat, lng);

        const existingSnap = await inletRef
          .where('nickName', '==', row.name)
          .where('description', '==', row.description || '')
          .where('geoHash', '==', geohash)
          .limit(1)
          .get();

        if (!existingSnap.empty) {
          const doc = existingSnap.docs[0];
          const existingData = doc.data();

          const updatedImages = Array.from(new Set([...(existingData.images || []), ...imageFiles]));

          const finalAddress = (existingData.address && existingData.address.trim()) || (row.address && row.address.trim()) || '';

          const isReady = updatedImages.length > 0 && finalAddress.length > 0;

          const updatePayload = {
            images: updatedImages,
          };

          if (!existingData.address && finalAddress) {
            updatePayload.address = finalAddress;
          }

          if (isReady && existingData.inletStatus !== 'ready') {
            updatePayload.inletStatus = 'ready';
          }

          batch.update(doc.ref, updatePayload);
        } else {
          const docRef = inletRef.doc();

          batch.set(docRef, {
            nickName: row.name,
            address: row.address || '',
            description: row.description || '',
            images: imageFiles,
            geoLocation: new GeoPoint(Number(row.latitude), Number(row.longitude)),
            geoHash: geohash,
            inletStatus: row?.address.trim() && imageFiles.length > 0 ? 'ready' : 'photo_needed',
          });
        }
      }

      await batch.commit();
    }

    await snap.ref.delete();
  },
);
