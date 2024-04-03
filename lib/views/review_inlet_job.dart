import 'dart:io';

import 'package:cleanlet/views/test.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../models/inlet.dart';
import '../services/firestore_repository.dart';

class ReviewInletJob extends ConsumerStatefulWidget {
  final Inlet inlet;

  const ReviewInletJob(this.inlet, {super.key});

  @override
  ConsumerState<ReviewInletJob> createState() => _ReviewInletJobState();
}

class _ReviewInletJobState extends ConsumerState<ReviewInletJob> {
  TextEditingController _notesController = TextEditingController();
  final storageRef = FirebaseStorage.instance.ref();
  File? _selectedBeforePhoto;
  File? _selectedAfterPhoto;
  bool _isUploading = false;

  Future<List<String>> _getInletPhotos() async {
    try {
      String beforePhoto = await storageRef.child('cleaning-images/${widget.inlet.jobId}/Before.jpg').getDownloadURL();
      String afterPhoto = await storageRef.child('cleaning-images/${widget.inlet.jobId}/After.jpg').getDownloadURL();

      return [beforePhoto, afterPhoto];
    } catch (e) {
      print('Error getting photos: $e');
      return [];
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
        appBar: AppBar(
          title: const Text('Review Inlet Job'),
        ),
        body: SingleChildScrollView(
            child: Column(children: [
          Container(child: Text('Before Photo')),
          SizedBox(height: 15),
          Container(
              alignment: Alignment.center,
              width: double.infinity,
              height: 300,
              child: FutureBuilder(
                  future: _getBeforePhoto(),
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return CircularProgressIndicator();
                    } else if (snapshot.hasError) {
                      return Center(child: Text('Error: ${snapshot.error}'));
                    } else {
                      return Column(
                        children: [
                          BuildBeforePreview(snapshot.data as String),
                          SizedBox(height: 20),
                          Container(
                            margin: const EdgeInsets.symmetric(horizontal: 20),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                              children: [
                                Expanded(
                                  child: ElevatedButton(
                                    onPressed: _isUploading
                                        ? null
                                        : () async {
                                            _selectBeforePhoto(ImageSource.camera);
                                          },
                                    child: const Text('Take a picture'),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: ElevatedButton(
                                    onPressed: _isUploading
                                        ? null
                                        : () async {
                                            _selectBeforePhoto(ImageSource.gallery);
                                          },
                                    child: const Text('Choose an image'),
                                  ),
                                ),
                              ],
                            ),
                          )
                        ],
                      );
                    }
                  })),
          Container(child: Text('After Photo')),
          SizedBox(height: 15),
          Container(
              alignment: Alignment.center,
              width: double.infinity,
              height: 300,
              child: FutureBuilder(
                  future: _getAfterPhoto(),
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return CircularProgressIndicator();
                    } else if (snapshot.hasError) {
                      return Center(child: Text('Error: ${snapshot.error}'));
                    } else {
                      return Column(
                        children: [
                          BuildAfterPreview(snapshot.data as String),
                          SizedBox(height: 20),
                          Container(
                            margin: const EdgeInsets.symmetric(horizontal: 20),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                              children: [
                                Expanded(
                                  child: ElevatedButton(
                                    onPressed: _isUploading
                                        ? null
                                        : () async {
                                            _selectAfterPhoto(ImageSource.camera);
                                          },
                                    child: const Text('Take a picture'),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: ElevatedButton(
                                    onPressed: _isUploading
                                        ? null
                                        : () async {
                                            _selectAfterPhoto(ImageSource.gallery);
                                          },
                                    child: const Text('Choose an image'),
                                  ),
                                ),
                              ],
                            ),
                          )
                        ],
                      );
                    }
                  })),
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 20),
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: TextField(controller: _notesController, decoration: InputDecoration(labelText: 'Add Notes', border: OutlineInputBorder())),
          ),
          Container(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: ElevatedButton(
                onPressed: _isUploading
                    ? null
                    : () async {
                        await _completeJob(ref);
                      },
                child: Text('Complete Job'),
              ))
        ])));
  }

  Future<String> _getBeforePhoto() async {
    try {
      String beforePhoto = await storageRef.child('cleaning-images/${widget.inlet.jobId}/Before.jpg').getDownloadURL();

      return beforePhoto;
    } catch (e) {
      return "";
    }
  }

  Future<String> _getAfterPhoto() async {
    try {
      String afterPhoto = await storageRef.child('cleaning-images/${widget.inlet.jobId}/After.jpg').getDownloadURL();

      return afterPhoto;
    } catch (e) {
      return "";
    }
  }

  Widget BuildBeforePreview(String photoURL) {
    return Container(child: _selectedBeforePhoto != null ? Image.file(_selectedBeforePhoto!, height: 200, width: double.infinity, fit: BoxFit.cover) : Image.network(photoURL, height: 200, width: double.infinity, fit: BoxFit.cover));
  }

  Widget BuildAfterPreview(String photoURL) {
    return Container(child: _selectedAfterPhoto != null ? Image.file(_selectedAfterPhoto!, height: 200, width: double.infinity, fit: BoxFit.cover) : Image.network(photoURL, height: 200, width: double.infinity, fit: BoxFit.cover));
  }

  Future<void> _selectBeforePhoto(ImageSource source) async {
    final pickedFile = await ImagePicker().pickImage(source: source);

    if (pickedFile != null) {
      try {
        setState(() {
          _selectedBeforePhoto = File(pickedFile.path);
          _isUploading = true;
        });
      } catch (e) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed to upload Before Image.')));
      } finally {
        setState(() {
          _isUploading = false;
        });
      }
    }
  }

  Future<void> _selectAfterPhoto(ImageSource source) async {
    final pickedFile = await ImagePicker().pickImage(source: source);

    if (pickedFile != null) {
      try {
        setState(() {
          _selectedAfterPhoto = File(pickedFile.path);
          _isUploading = true;
        });

        await storageRef.child('cleaning-images/${widget.inlet.jobId}/After.jpg').putFile(_selectedAfterPhoto!);
      } catch (e) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed to upload After Image.')));
      } finally {
        setState(() {
          _isUploading = false;
        });
      }
    }
  }

  Future<void> _completeJob(ref) async {
    final database = ref.read(databaseProvider);
    await database.updateInlet(widget.inlet.referenceId, data: {'status': 'cleaned'});
    await database.updateJob(widget.inlet.jobId, data: {"finishedAt": Timestamp.now(), "status": "cleaned", "notes": _notesController.text});
    _showMyDialog();
  }

  Future<void> _showMyDialog() async {
    return showDialog<void>(
      context: context,
      barrierDismissible: false, // user must tap button!
      builder: (BuildContext context) {
        return AlertDialog(
          title: const Text('Cleaning complete'),
          content: const SingleChildScrollView(
            child: ListBody(
              children: <Widget>[
                Text('Thank you for cleaning this inlet'),
                Text('Your points will be awarded shortly'),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              child: const Text('Continue'),
              onPressed: () {
                Navigator.pushNamedAndRemoveUntil(context, '/home', (route) => false);
              },
            ),
          ],
        );
      },
    );
  }
}
