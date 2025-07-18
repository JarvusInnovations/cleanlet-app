import 'package:cleanlet/services/firestore_repository.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'dart:io';

import '../../models/inlet.dart';

class UploadPhoto extends ConsumerStatefulWidget {
  final Inlet inlet;
  const UploadPhoto(this.inlet, {super.key});

  @override
  ConsumerState<UploadPhoto> createState() => _UploadPhotoState();
}

class _UploadPhotoState extends ConsumerState<UploadPhoto> {
  File? _image;
  final _picker = ImagePicker();
  final storageRef = FirebaseStorage.instance.ref();

  Future<void> _openImagePicker(ImageSource source) async {
    final XFile? pickedImage = await _picker.pickImage(source: source);

    if (pickedImage != null) {
      setState(() {
        _image = File(pickedImage.path);
      });
    }
  }

  Future<void> _showMyDialog() async {
    return showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (BuildContext context) {
          return AlertDialog(
              title: const Text('Photo Uploaded'),
              content: const SingleChildScrollView(
                  child: ListBody(
                children: <Widget>[
                  Text('Thank you for uploading a photo'),
                  Text('Admins will review your photos'),
                ],
              )),
              actions: <Widget>[
                TextButton(
                  child: const Text('Return to Home'),
                  onPressed: () {
                    Navigator.pushNamedAndRemoveUntil(context, '/home', (route) => false);
                  },
                )
              ]);
        });
  }

  @override
  Widget build(BuildContext context) {
    final imagesRef = storageRef.child('inlet-photos');
    final imageRef = imagesRef.child('${Timestamp.now().toDate().toString()}-${widget.inlet.referenceId}.jpg');

    return Scaffold(
        appBar: AppBar(title: Text('Upload Photo')),
        body: SafeArea(
            child: Center(
                child: Column(children: [
          Container(alignment: Alignment.center, width: double.infinity, height: 261, color: Colors.grey[300], child: _image != null ? Image.file(_image!, fit: BoxFit.cover) : const Align(alignment: Alignment.center, child: Text('Please select take a photo or choose an image from your photo gallery', textAlign: TextAlign.center))),
          Container(
              margin: const EdgeInsets.symmetric(horizontal: 20.0, vertical: 20.0),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  Expanded(
                    child: ElevatedButton(
                      onPressed: () async {
                        _openImagePicker(ImageSource.camera);
                      },
                      child: const Text('Take a picture'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: ElevatedButton(
                      onPressed: () async {
                        _openImagePicker(ImageSource.gallery);
                      },
                      child: const Text('Choose an image'),
                    ),
                  ),
                ],
              )),
          const Spacer(),
          Container(
              margin: const EdgeInsets.symmetric(horizontal: 10.0),
              child: ElevatedButton.icon(
                onPressed: _image == null
                    ? null
                    : () async {
                        String filename = '${widget.inlet.referenceId}.jpg';
                        await imagesRef.child(filename).putFile(_image!);
                        final database = ref.read(databaseProvider);
                        List<String> photos = [filename];

                        await database.updateInlet(widget.inlet.referenceId, data: {"images": photos, "inletStatus": "review"});
                        _showMyDialog();
                      },
                icon: const Icon(Icons.check),
                label: const Text("Upload Photo"),
                style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(40)),
              ))
        ]))));
  }
}
