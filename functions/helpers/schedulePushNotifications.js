import { Timestamp } from 'firebase-admin/firestore';

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
